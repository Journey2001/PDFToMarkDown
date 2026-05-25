# PDFToMarkDown 四子应用单后端重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前单页混合式 Markdown 工具重构为单后端服务、四个独立子应用入口和一个总壳入口，并支持下载页多 URL 自定义保存目录、清洗/翻译/导出页按顶层目录扫描后多选批量处理。

**Architecture:** 保留 Node 单后端，先把 `scripts/gui-server.mjs` 中的路由、任务、路径校验、文件扫描和脚本调用拆入 `server/` 分层；再将当前 `gui/` 单页拆为 `apps/download-ui`、`apps/clean-ui`、`apps/translate-ui`、`apps/export-ui` 和 `apps/shell-ui` 五个入口，统一复用共享 API 与任务轮询逻辑。

**Tech Stack:** Node.js ESM, 原生 `node:test`, Playwright Chromium, 现有 Markdown CLI 脚本, 原生浏览器前端

---

## File Structure

本计划将围绕以下文件落地：

- Create: `server/server.mjs`
- Create: `server/routes/config.mjs`
- Create: `server/routes/files.mjs`
- Create: `server/routes/jobs.mjs`
- Create: `server/routes/download.mjs`
- Create: `server/routes/clean.mjs`
- Create: `server/routes/translate.mjs`
- Create: `server/routes/export.mjs`
- Create: `server/services/download-service.mjs`
- Create: `server/services/clean-service.mjs`
- Create: `server/services/translate-service.mjs`
- Create: `server/services/export-service.mjs`
- Create: `server/shared/http.mjs`
- Create: `server/shared/paths.mjs`
- Create: `server/shared/files.mjs`
- Create: `server/shared/job-store.mjs`
- Create: `server/shared/config.mjs`
- Create: `apps/shared/api.js`
- Create: `apps/shared/jobs.js`
- Create: `apps/shared/markdown-picker.js`
- Create: `apps/shared/layout.css`
- Create: `apps/download-ui/index.html`
- Create: `apps/download-ui/app.js`
- Create: `apps/clean-ui/index.html`
- Create: `apps/clean-ui/app.js`
- Create: `apps/translate-ui/index.html`
- Create: `apps/translate-ui/app.js`
- Create: `apps/export-ui/index.html`
- Create: `apps/export-ui/app.js`
- Create: `apps/shell-ui/index.html`
- Create: `apps/shell-ui/app.js`
- Modify: `scripts/gui-server.mjs`
- Modify: `start-gui.bat`
- Modify: `package.json`
- Test: `tests/server-routes.test.mjs`
- Test: `tests/job-store.test.mjs`
- Test: `tests/files-scan.test.mjs`
- Test: `tests/gui-multi-app.test.mjs`

## Task 1: 抽离后端共享基础设施

**Files:**
- Create: `server/shared/http.mjs`
- Create: `server/shared/paths.mjs`
- Create: `server/shared/files.mjs`
- Create: `server/shared/config.mjs`
- Modify: `scripts/gui-server.mjs`
- Test: `tests/files-scan.test.mjs`

- [ ] **Step 1: 写失败测试，固定目录扫描与路径保护行为**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isPathInsideRoot,
  listMarkdownFilesFromRoot
} from '../server/shared/files.mjs';

test('listMarkdownFilesFromRoot 只返回顶层目录下递归扫描到的 md 文件', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-scan-'));

  try {
    await mkdir(path.join(tempDir, 'nested'));
    await mkdir(path.join(tempDir, 'node_modules'));
    await writeFile(path.join(tempDir, 'README.md'), '# root', 'utf8');
    await writeFile(path.join(tempDir, 'nested', 'guide.md'), '# child', 'utf8');
    await writeFile(path.join(tempDir, 'node_modules', 'skip.md'), '# skip', 'utf8');

    const files = await listMarkdownFilesFromRoot(tempDir, tempDir);
    assert.deepEqual(files.map((file) => file.relativePath), ['README.md', path.join('nested', 'guide.md')]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('isPathInsideRoot 会拒绝越出项目根目录的路径', () => {
  assert.equal(isPathInsideRoot('D:\\repo\\output\\a.md', 'D:\\repo'), true);
  assert.equal(isPathInsideRoot('D:\\other\\a.md', 'D:\\repo'), false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/files-scan.test.mjs`

Expected: FAIL，提示 `Cannot find module '../server/shared/files.mjs'`

- [ ] **Step 3: 实现后端共享工具**

```javascript
// server/shared/files.mjs
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

export function isPathInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return candidatePath === rootPath || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function listMarkdownFilesFromRoot(scanRoot, projectRoot) {
  const queue = [path.resolve(scanRoot)];
  const results = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      const fileStat = await stat(fullPath);
      results.push({
        path: fullPath,
        relativePath: path.relative(projectRoot, fullPath),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString()
      });
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
```

```javascript
// server/shared/http.mjs
export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `node --test tests/files-scan.test.mjs`

Expected: PASS，2 tests passed

- [ ] **Step 5: Commit**

```bash
git add tests/files-scan.test.mjs server/shared/files.mjs server/shared/http.mjs
git commit -m "refactor: extract shared backend file utilities"
```

## Task 2: 建立统一任务模型与后端路由骨架

**Files:**
- Create: `server/shared/job-store.mjs`
- Create: `server/routes/jobs.mjs`
- Create: `server/routes/files.mjs`
- Create: `server/routes/config.mjs`
- Create: `server/server.mjs`
- Test: `tests/job-store.test.mjs`
- Test: `tests/server-routes.test.mjs`

- [ ] **Step 1: 写失败测试，固定任务状态和基础接口**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobStore } from '../server/shared/job-store.mjs';

test('createJobStore 会创建批量任务并追加子项状态', () => {
  const store = createJobStore();
  const job = store.createJob({
    jobType: 'clean',
    inputSummary: { fileCount: 2 },
    items: [{ source: 'a.md' }, { source: 'b.md' }]
  });

  assert.equal(job.status, 'queued');
  assert.equal(job.totalItems, 2);

  store.updateItem(job.jobId, job.items[0].itemId, { status: 'completed', output: 'a.cleaned.md' });
  const snapshot = store.getJob(job.jobId);
  assert.equal(snapshot.completedItems, 1);
});
```

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createServer } from '../server/server.mjs';

test('GET /api/config 返回多入口模式配置', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    const payload = await response.json();
    assert.equal(payload.apps.length, 5);
    assert.equal(payload.apps[0].id, 'download');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/job-store.test.mjs tests/server-routes.test.mjs`

Expected: FAIL，提示缺少 `job-store.mjs` 或 `server.mjs`

- [ ] **Step 3: 实现统一任务仓库与基础服务入口**

```javascript
// server/shared/job-store.mjs
import { randomUUID } from 'node:crypto';

export function createJobStore() {
  const jobs = new Map();

  function recalc(job) {
    job.totalItems = job.items.length;
    job.completedItems = job.items.filter((item) => item.status === 'completed').length;
    job.failedItems = job.items.filter((item) => item.status === 'failed').length;
    job.cancelledItems = job.items.filter((item) => item.status === 'cancelled').length;
    if (job.failedItems > 0) {
      job.status = 'failed';
    } else if (job.completedItems === job.totalItems) {
      job.status = 'completed';
    } else if (job.items.some((item) => item.status === 'running')) {
      job.status = 'running';
    }
  }

  return {
    createJob({ jobType, inputSummary, items }) {
      const jobId = randomUUID();
      const job = {
        jobId,
        jobType,
        inputSummary,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        completedItems: 0,
        failedItems: 0,
        cancelledItems: 0,
        totalItems: items.length,
        items: items.map((item) => ({
          itemId: randomUUID(),
          status: 'queued',
          output: null,
          error: null,
          logs: [],
          ...item
        }))
      };
      jobs.set(jobId, job);
      return structuredClone(job);
    },
    getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? structuredClone(job) : null;
    },
    updateItem(jobId, itemId, patch) {
      const job = jobs.get(jobId);
      const item = job?.items.find((entry) => entry.itemId === itemId);
      if (!job || !item) {
        return null;
      }
      Object.assign(item, patch);
      if (!job.startedAt && patch.status === 'running') {
        job.startedAt = new Date().toISOString();
      }
      recalc(job);
      if (job.status === 'completed' || job.status === 'failed') {
        job.finishedAt = new Date().toISOString();
      }
      return structuredClone(job);
    }
  };
}
```

```javascript
// server/server.mjs
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendJson } from './shared/http.mjs';
import { registerConfigRoutes } from './routes/config.mjs';
import { registerFileRoutes } from './routes/files.mjs';
import { registerJobRoutes } from './routes/jobs.mjs';
import { createJobStore } from './shared/job-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export function createServer() {
  const jobStore = createJobStore();
  const routes = [
    ...registerConfigRoutes({ projectRoot }),
    ...registerFileRoutes({ projectRoot }),
    ...registerJobRoutes({ jobStore })
  ];

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    const route = routes.find((entry) => entry.method === request.method && entry.match(url.pathname));
    if (!route) {
      sendJson(response, 404, { ok: false, error: 'Not found' });
      return;
    }
    await route.handle({ request, response, url });
  });
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `node --test tests/job-store.test.mjs tests/server-routes.test.mjs`

Expected: PASS，所有任务仓库与基础接口测试通过

- [ ] **Step 5: Commit**

```bash
git add tests/job-store.test.mjs tests/server-routes.test.mjs server/shared/job-store.mjs server/routes/config.mjs server/routes/files.mjs server/routes/jobs.mjs server/server.mjs
git commit -m "refactor: add shared job model and route skeleton"
```

## Task 3: 接入四类服务并把下载/清洗/翻译/导出统一改为任务接口

**Files:**
- Create: `server/services/download-service.mjs`
- Create: `server/services/clean-service.mjs`
- Create: `server/services/translate-service.mjs`
- Create: `server/services/export-service.mjs`
- Create: `server/routes/download.mjs`
- Create: `server/routes/clean.mjs`
- Create: `server/routes/translate.mjs`
- Create: `server/routes/export.mjs`
- Modify: `server/server.mjs`
- Test: `tests/server-routes.test.mjs`

- [ ] **Step 1: 为下载与目录扫描批量接口写失败测试**

```javascript
test('POST /api/files/scan-markdown 扫描顶层目录下的 md 文件', async () => {
  const scanRoot = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-scan-api-'));
  await writeFile(path.join(scanRoot, 'one.md'), '# one', 'utf8');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/files/scan-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoot })
    });
    const payload = await response.json();
    assert.equal(payload.files.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(scanRoot, { recursive: true, force: true });
  }
});

test('POST /api/download/jobs 会创建多 URL 下载任务', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/download/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrls: ['https://github.com/owner/repo/blob/main/README.md'],
        outputRoot: 'D:\\AIPainting\\PDFToMarkDown\\output'
      })
    });
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.job.totalItems, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/server-routes.test.mjs`

Expected: FAIL，提示 `/api/files/scan-markdown` 或 `/api/download/jobs` 尚未注册

- [ ] **Step 3: 实现四类服务层与任务型路由**

```javascript
// server/services/download-service.mjs
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runDownloadJob({ githubUrl, outputRoot, cwd }) {
  const script = path.join(cwd, 'scripts', 'export-awesome-gpt-image-pdf.mjs');
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    '--json',
    '--markdown-only',
    '--github-url',
    githubUrl,
    '--output',
    outputRoot
  ], { cwd });
  return JSON.parse(stdout.trim());
}
```

```javascript
// server/routes/download.mjs
import { readJsonBody, sendJson } from '../shared/http.mjs';

export function registerDownloadRoutes({ jobStore, projectRoot, services }) {
  return [{
    method: 'POST',
    match: (pathname) => pathname === '/api/download/jobs',
    async handle({ request, response }) {
      const payload = await readJsonBody(request);
      const job = jobStore.createJob({
        jobType: 'download',
        inputSummary: { outputRoot: payload.outputRoot },
        items: payload.githubUrls.map((url) => ({ source: url }))
      });

      queueMicrotask(async () => {
        for (const item of job.items) {
          jobStore.updateItem(job.jobId, item.itemId, { status: 'running' });
          try {
            const result = await services.download.run({
              githubUrl: item.source,
              outputRoot: payload.outputRoot,
              cwd: projectRoot
            });
            jobStore.updateItem(job.jobId, item.itemId, { status: 'completed', output: result.markdownPath, stats: result });
          } catch (error) {
            jobStore.updateItem(job.jobId, item.itemId, { status: 'failed', error: error.message });
          }
        }
      });

      sendJson(response, 200, { ok: true, job });
    }
  }];
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `node --test tests/server-routes.test.mjs`

Expected: PASS，新增任务型接口返回 `jobId`、`totalItems`、扫描结果

- [ ] **Step 5: Commit**

```bash
git add server/services/download-service.mjs server/services/clean-service.mjs server/services/translate-service.mjs server/services/export-service.mjs server/routes/download.mjs server/routes/clean.mjs server/routes/translate.mjs server/routes/export.mjs server/server.mjs tests/server-routes.test.mjs
git commit -m "feat: add task-based service routes for four app domains"
```

## Task 4: 拆出前端共享模块并实现下载子应用

**Files:**
- Create: `apps/shared/api.js`
- Create: `apps/shared/jobs.js`
- Create: `apps/shared/layout.css`
- Create: `apps/download-ui/index.html`
- Create: `apps/download-ui/app.js`
- Modify: `package.json`
- Test: `tests/gui-multi-app.test.mjs`

- [ ] **Step 1: 为下载子应用入口写失败测试**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('download-ui 页面包含多 URL 输入和保存目录字段', async () => {
  const html = await readFile(new URL('../apps/download-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /textarea[^>]+name="githubUrls"/);
  assert.match(html, /input[^>]+name="outputRoot"/);
  assert.match(html, /提交下载任务/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/gui-multi-app.test.mjs`

Expected: FAIL，提示缺少 `apps/download-ui/index.html`

- [ ] **Step 3: 实现共享 API、任务轮询和下载页面**

```javascript
// apps/shared/api.js
export async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${url}`);
  }
  return data;
}
```

```javascript
// apps/download-ui/app.js
import { postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';

const form = document.querySelector('#download-form');
const taskList = document.querySelector('#task-list');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const githubUrls = formData.get('githubUrls').toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const outputRoot = formData.get('outputRoot').toString().trim();
  const created = await postJson('/api/download/jobs', { githubUrls, outputRoot });
  const job = await pollJobUntilSettled(created.job.jobId);
  taskList.textContent = JSON.stringify(job, null, 2);
});
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `node --test tests/gui-multi-app.test.mjs`

Expected: PASS，下载页基础入口存在且字段命名正确

- [ ] **Step 5: Commit**

```bash
git add apps/shared/api.js apps/shared/jobs.js apps/shared/layout.css apps/download-ui/index.html apps/download-ui/app.js tests/gui-multi-app.test.mjs package.json
git commit -m "feat: add download sub-app entry and shared frontend api layer"
```

## Task 5: 实现清洗/翻译/导出三个目录扫描型子应用

**Files:**
- Create: `apps/shared/markdown-picker.js`
- Create: `apps/clean-ui/index.html`
- Create: `apps/clean-ui/app.js`
- Create: `apps/translate-ui/index.html`
- Create: `apps/translate-ui/app.js`
- Create: `apps/export-ui/index.html`
- Create: `apps/export-ui/app.js`
- Modify: `tests/gui-multi-app.test.mjs`

- [ ] **Step 1: 为目录扫描型页面写失败测试**

```javascript
test('clean-ui 页面包含 scanRoot 和 markdown 多选列表', async () => {
  const html = await readFile(new URL('../apps/clean-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /input[^>]+name="scanRoot"/);
  assert.match(html, /select[^>]+id="markdown-files"[^>]*multiple/);
});

test('translate-ui 页面包含翻译参数字段', async () => {
  const html = await readFile(new URL('../apps/translate-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="targetLanguage"/);
  assert.match(html, /name="translateModel"/);
  assert.match(html, /name="deepseekApiKey"/);
});

test('export-ui 页面包含目录扫描和导出任务提交按钮', async () => {
  const html = await readFile(new URL('../apps/export-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /扫描 Markdown/);
  assert.match(html, /提交导出任务/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/gui-multi-app.test.mjs`

Expected: FAIL，提示三个入口页尚未创建

- [ ] **Step 3: 实现共享目录扫描选择器与三个页面**

```javascript
// apps/shared/markdown-picker.js
import { postJson } from './api.js';

export async function scanMarkdownInto(selectElement, scanRoot) {
  const result = await postJson('/api/files/scan-markdown', { scanRoot });
  selectElement.innerHTML = '';
  result.files.forEach((file) => {
    const option = document.createElement('option');
    option.value = file.path;
    option.textContent = file.relativePath;
    option.selected = true;
    selectElement.append(option);
  });
  return result.files;
}
```

```javascript
// apps/clean-ui/app.js
import { postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';
import { scanMarkdownInto } from '../shared/markdown-picker.js';

const scanForm = document.querySelector('#scan-form');
const runForm = document.querySelector('#run-form');
const select = document.querySelector('#markdown-files');

scanForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const scanRoot = new FormData(scanForm).get('scanRoot').toString().trim();
  await scanMarkdownInto(select, scanRoot);
});

runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const markdownPaths = [...select.selectedOptions].map((option) => option.value);
  const created = await postJson('/api/clean/jobs', { markdownPaths });
  await pollJobUntilSettled(created.job.jobId);
});
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `node --test tests/gui-multi-app.test.mjs`

Expected: PASS，三个目录扫描型子应用入口存在且表单字段完整

- [ ] **Step 5: Commit**

```bash
git add apps/shared/markdown-picker.js apps/clean-ui/index.html apps/clean-ui/app.js apps/translate-ui/index.html apps/translate-ui/app.js apps/export-ui/index.html apps/export-ui/app.js tests/gui-multi-app.test.mjs
git commit -m "feat: add folder-scan sub-apps for clean translate and export"
```

## Task 6: 接入总壳入口、静态分发与启动方式

**Files:**
- Create: `apps/shell-ui/index.html`
- Create: `apps/shell-ui/app.js`
- Modify: `server/server.mjs`
- Modify: `scripts/gui-server.mjs`
- Modify: `start-gui.bat`
- Modify: `package.json`
- Test: `tests/gui-multi-app.test.mjs`

- [ ] **Step 1: 为总壳入口与静态分发写失败测试**

```javascript
test('shell-ui 页面包含四个分页导航入口', async () => {
  const html = await readFile(new URL('../apps/shell-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-app="download"/);
  assert.match(html, /data-app="clean"/);
  assert.match(html, /data-app="translate"/);
  assert.match(html, /data-app="export"/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/gui-multi-app.test.mjs`

Expected: FAIL，提示缺少 `apps/shell-ui/index.html`

- [ ] **Step 3: 实现总壳页面与静态入口映射**

```javascript
// server/server.mjs 内新增静态入口分发
const staticEntrypoints = new Map([
  ['/', path.join(projectRoot, 'apps', 'shell-ui', 'index.html')],
  ['/download', path.join(projectRoot, 'apps', 'download-ui', 'index.html')],
  ['/clean', path.join(projectRoot, 'apps', 'clean-ui', 'index.html')],
  ['/translate', path.join(projectRoot, 'apps', 'translate-ui', 'index.html')],
  ['/export', path.join(projectRoot, 'apps', 'export-ui', 'index.html')]
]);
```

```javascript
// apps/shell-ui/app.js
const frame = document.querySelector('#app-frame');

document.querySelectorAll('[data-app]').forEach((button) => {
  button.addEventListener('click', () => {
    frame.src = `/${button.dataset.app}`;
  });
});

frame.src = '/download';
```

- [ ] **Step 4: 再跑完整测试确认通过**

Run: `node --test`

Expected: PASS，原有 `clean-markdown`、`translate-markdown`、`export-workflow` 测试继续通过，新增服务端与多入口 UI 测试通过

- [ ] **Step 5: Commit**

```bash
git add apps/shell-ui/index.html apps/shell-ui/app.js server/server.mjs scripts/gui-server.mjs start-gui.bat package.json tests/gui-multi-app.test.mjs
git commit -m "feat: add shell entry and serve five web app entrypoints"
```

## Task 7: 运行时回归与交付检查

**Files:**
- Modify: `README.md`
- Test: `tests/gui-multi-app.test.mjs`

- [ ] **Step 1: 更新 README，写清五个入口与新批量方式**

```markdown
## GUI 子应用入口

- `/download`：多 GitHub URL 下载与自定义保存目录
- `/clean`：顶层目录扫描后多选批量清洗
- `/translate`：顶层目录扫描后多选批量翻译
- `/export`：顶层目录扫描后多选批量导出 HTML / PDF
- `/`：总壳入口，内含四个分页
```

- [ ] **Step 2: 运行后端与 GUI 手工冒烟**

Run: `npm run gui`

Expected:

- 浏览器默认打开 `/`
- 总壳可切换四个分页
- `/download` 可提交多 URL 任务
- `/clean`、`/translate`、`/export` 可输入目录并扫描 Markdown 列表

- [ ] **Step 3: 记录回归验证命令**

Run: `node --test`

Expected: PASS，全部测试通过

Run: `npx playwright install chromium`

Expected: Chromium 已安装或输出已存在

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update gui usage for multi-app workflow"
```

## Self-Review Checklist

- 规格覆盖：已覆盖单后端、多入口、下载自定义目录、三页目录扫描、多任务统一模型、总壳复用
- 占位词扫描：计划中不使用 `TODO`、`TBD`、`类似上一步`
- 命名一致性：统一使用 `download / clean / translate / export / shell`，接口统一使用 `/api/*/jobs`
