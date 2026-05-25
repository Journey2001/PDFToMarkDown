# Translate Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不更换现有 DeepSeek 引擎的前提下，同时优化 Markdown 翻译速度和翻译效果，让输出更接近 `markdown-zh-localizer` 的中文本地化风格。

**Architecture:** 保留现有 Node.js 翻译脚本作为唯一执行入口，但把“块级跳过判断、占位符保护、缓存、可调并发、面向 prompt 的系统提示词”内聚到翻译核心中。GUI 和 HTTP 接口只负责把新参数透传给翻译器，并展示更准确的进度和结果。

**Tech Stack:** Node.js ESM, 原生 `node:test`, DeepSeek Chat Completions API, 现有轻量 HTTP GUI

---

### Task 1: 为翻译核心补回归测试

**Files:**
- Create: `D:\AIPainting\PDFToMarkDown\tests\translate-markdown.test.mjs`
- Modify: `D:\AIPainting\PDFToMarkDown\package.json`
- Test: `D:\AIPainting\PDFToMarkDown\tests\translate-markdown.test.mjs`

- [ ] **Step 1: 编写失败测试，覆盖中文主导跳过、缓存命中、链接目标保护**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createTranslationRuntime,
  maskProtectedTokens,
  shouldTranslateChunk
} from '../scripts/translate-markdown.mjs';

test('中文主导段落应跳过翻译', () => {
  const input = '整体已经是中文，只夹杂 OpenAI、TikTok 和 prompt 这些英文词。';
  assert.equal(shouldTranslateChunk(input, { targetLanguage: 'zh-CN' }), false);
});

test('Markdown 链接文本可翻译，但链接目标必须保留', () => {
  const input = '[What does it do?](https://example.com/demo)';
  const { masked, tokens } = maskProtectedTokens(input, 1);
  assert.match(masked, /\[What does it do\?\]\(__PDF_MD_TOKEN_1_0__\)/);
  assert.equal(tokens[0].value, 'https://example.com/demo');
});

test('第二次运行应命中缓存，不再调用翻译器', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-cache-'));
  const cachePath = path.join(tempDir, 'cache.json');
  let callCount = 0;

  const runtime = createTranslationRuntime({
    translator: async (content) => {
      callCount += 1;
      return content.replace('Hello world', '你好，世界');
    }
  });

  try {
    const first = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      maxChars: 12000,
      concurrency: 1,
      cacheFile: cachePath
    });

    const second = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      maxChars: 12000,
      concurrency: 1,
      cacheFile: cachePath
    });

    assert.equal(first.content, '你好，世界');
    assert.equal(second.content, '你好，世界');
    assert.equal(callCount, 1);
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(Object.keys(cache).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认当前实现失败**

Run: `node --test tests/translate-markdown.test.mjs`
Expected: FAIL，原因至少包括“未导出 createTranslationRuntime / shouldTranslateChunk”或缓存行为不存在。

- [ ] **Step 3: 为测试入口补 package script**

```json
{
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 4: 再次运行测试，确认仍然是红灯但入口可用**

Run: `npm test -- --test-name-pattern="翻译"`
Expected: FAIL，并显示新增测试已被 Node 测试运行器发现。

- [ ] **Step 5: 提交当前测试基线**

```bash
git add package.json tests/translate-markdown.test.mjs
git commit -m "test: add translation optimizer regression coverage"
```

### Task 2: 重构翻译核心，解决速度问题

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\translate-markdown.mjs`
- Test: `D:\AIPainting\PDFToMarkDown\tests\translate-markdown.test.mjs`

- [ ] **Step 1: 抽出可注入 translator 的运行时工厂**

```javascript
export function createTranslationRuntime({ translator = requestTranslation } = {}) {
  return {
    translateMarkdown(markdown, options) {
      return translateMarkdownInternal(markdown, normalizeOptions(options), translator);
    }
  };
}
```

- [ ] **Step 2: 实现中文主导跳过规则与更细粒度文本判定**

```javascript
function shouldTranslateChunk(chunk, options) {
  const trimmed = chunk.trim();
  if (!trimmed) return false;
  if (options.targetLanguage !== 'zh-CN') return true;
  if (isChineseMajorityChunk(trimmed)) return false;
  return hasEnoughForeignText(trimmed);
}
```

- [ ] **Step 3: 加入持久化缓存与缓存统计**

```javascript
async function loadCache(cacheFile) {
  if (!cacheFile) return {};
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function buildCacheKey(entry, options) {
  return createHash('sha256')
    .update(JSON.stringify([options.targetLanguage, options.model, entry.original]))
    .digest('hex');
}
```

- [ ] **Step 4: 增加可配置并发，并把缓存命中从总任务数中剔除**

```javascript
const workerCount = Math.min(options.concurrency, pendingWorkItems.length || 1);
emitProgress(options, {
  stage: 'start',
  totalWorkItems: pendingWorkItems.length,
  cachedWorkItems: cachedEntries.length,
  concurrency: options.concurrency
});
```

- [ ] **Step 5: 运行测试，确认红灯转绿**

Run: `node --test tests/translate-markdown.test.mjs`
Expected: PASS

- [ ] **Step 6: 运行一次 CLI dry verification，确认新参数可解析**

Run: `node scripts/translate-markdown.mjs --help`
Expected: 输出新增 `--concurrency`、`--cache-file` 等参数说明。

- [ ] **Step 7: 提交速度优化实现**

```bash
git add scripts/translate-markdown.mjs tests/translate-markdown.test.mjs
git commit -m "feat: speed up markdown translation with cache and concurrency controls"
```

### Task 3: 调整 prompt 与保护策略，提升翻译效果

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\translate-markdown.mjs`
- Test: `D:\AIPainting\PDFToMarkDown\tests\translate-markdown.test.mjs`

- [ ] **Step 1: 升级系统提示词，显式支持 prompt / 营销文案本地化**

```javascript
function buildSystemPrompt(options, segmentCount) {
  return [
    `Translate user-provided Markdown into ${options.targetLanguage}.`,
    'Localize prompt-like content into natural Simplified Chinese instead of literal translation.',
    'Preserve constraints such as counts, composition, camera, lighting, materials, color, and layout.',
    'Keep brand names, product names, placeholders, URLs, paths, HTML tags, and code identifiers unchanged.',
    'If a block is already Chinese-majority, return it unchanged.',
    'Return only translated Markdown.'
  ].join(' ');
}
```

- [ ] **Step 2: 将 Markdown 链接目标、模板占位符、HTML 标签与路径改为更精确保护**

```javascript
protect(/\{argument\b[^{}]*\}/g);
protect(/(?<=\]\()[^)]+(?=\))/g);
protect(/https?:\/\/[^\s)"'>]+/g);
protect(/<[^>]+>/g);
protect(/`[^`\n]+`/g);
```

- [ ] **Step 3: 为保护策略补断言**

```javascript
test('模板占位符必须原样保留', () => {
  const input = '{argument name="hair color" default="dark brown"}';
  const { masked, tokens } = maskProtectedTokens(input, 2);
  assert.equal(masked, '__PDF_MD_TOKEN_2_0__');
  assert.equal(tokens[0].value, input);
});
```

- [ ] **Step 4: 运行测试，确认效果策略没有破坏结构保护**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交效果优化实现**

```bash
git add scripts/translate-markdown.mjs tests/translate-markdown.test.mjs
git commit -m "feat: improve markdown translation localization quality"
```

### Task 4: 接入 GUI 与接口配置

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\gui-server.mjs`
- Modify: `D:\AIPainting\PDFToMarkDown\gui\app.js`
- Modify: `D:\AIPainting\PDFToMarkDown\gui\index.html`

- [ ] **Step 1: 为 `/api/config` 和 `/api/translate` 增加并发/缓存参数透传**

```javascript
const translatePayload = {
  inputPath,
  outputPath,
  targetLanguage,
  apiKey,
  model,
  concurrency,
  cacheFile
};
```

- [ ] **Step 2: 在 GUI 表单中新增并发和缓存路径输入**

```html
<label class="field">
  <span>翻译并发</span>
  <input id="translate-concurrency-input" name="translateConcurrency" type="number" min="1" max="16" placeholder="6" />
</label>
<label class="field">
  <span>缓存文件</span>
  <input id="translate-cache-file" name="translateCacheFile" type="text" placeholder="留空则自动生成 .translation-cache.json" />
</label>
```

- [ ] **Step 3: 在前端保存本地偏好，并显示缓存命中统计**

```javascript
const storageKeys = {
  apiKey: 'pdf-to-markdown.deepseekApiKey',
  model: 'pdf-to-markdown.translateModel',
  concurrency: 'pdf-to-markdown.translateConcurrency',
  cacheFile: 'pdf-to-markdown.translateCacheFile'
};
```

- [ ] **Step 4: 启动 GUI 服务做接口冒烟验证**

Run: `node scripts/gui-server.mjs`
Expected: 控制台输出 `GUI available at http://127.0.0.1:3210`

- [ ] **Step 5: 提交 GUI 配置接入**

```bash
git add scripts/gui-server.mjs gui/app.js gui/index.html
git commit -m "feat: expose translation performance controls in gui"
```

### Task 5: 完整验证与验收

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\README.md`
- Test: `D:\AIPainting\PDFToMarkDown\tests\translate-markdown.test.mjs`

- [ ] **Step 1: 更新 README 的翻译参数说明**

```markdown
node scripts/translate-markdown.mjs --input output/zh-CN/README.zh-CN.md --api-key "你的 DeepSeek API Key" --concurrency 6 --cache-file output/.translation-cache.json
```

- [ ] **Step 2: 运行完整测试**

Run: `npm test`
Expected: PASS，0 failures

- [ ] **Step 3: 运行一次真实 CLI 验证，确认结果文件可生成**

Run: `node scripts/translate-markdown.mjs --input "output/evolinkai-awesome-gpt-image-2-api-and-prompts-ui_zh-cn-181fa97a/ui_zh-CN.cleaned.md" --output "output/evolinkai-awesome-gpt-image-2-api-and-prompts-ui_zh-cn-181fa97a/ui_zh-CN.optimized.zh-CN.md" --api-key "<real-key>" --concurrency 6 --cache-file "output/.translation-cache.json" --json`
Expected: 返回 JSON，包含 `elapsedMs`、`cacheHitCount`、`translatedEntryCount`

- [ ] **Step 4: 做一次 review 式检查**

Run: `rg -n "TODO|TBD|PLACEHOLDER" scripts gui README.md tests`
Expected: 无新增占位符残留

- [ ] **Step 5: 提交文档与最终修正**

```bash
git add README.md
git commit -m "docs: document optimized markdown translation workflow"
```
