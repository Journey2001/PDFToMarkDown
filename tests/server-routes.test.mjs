import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createJobStore } from '../server/shared/job-store.mjs';
import { createAppServer } from '../server/server.mjs';

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-to-markdown-server-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function startServer(options = {}) {
  const jobStore = options.jobStore ?? createJobStore();
  const server = createAppServer({
    projectRoot: options.projectRoot,
    jobStore,
    services: options.services
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    jobStore,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function requestJson(origin, pathname, init) {
  const response = await fetch(new URL(pathname, origin), init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function waitFor(assertion, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError ?? new Error('Timed out while waiting for assertion');
}

async function requestRawPath(origin, pathname) {
  const url = new URL(origin);

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: pathname,
      method: 'GET'
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });

    request.on('error', reject);
    request.end();
  });
}

test('/api/config 返回多入口 app 配置', async () => {
  const { origin, close } = await startServer();

  try {
    const response = await requestJson(origin, '/api/config');

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(Array.isArray(response.body.apps), true);
    assert.deepEqual(
      response.body.apps.map((app) => app.id),
      ['download', 'clean', 'translate', 'export', 'shell']
    );
  } finally {
    await close();
  }
});

test('POST /api/download/jobs 会把 outputRoot 绑定到 projectRoot 并在完成后收敛父 job 状态', async () => {
  await withTempDir(async (projectRoot) => {
    const calls = [];
    const services = {
      download: {
        run: async (input) => {
          calls.push(input);
          return {
            markdownPath: path.join(input.outputRoot, `${calls.length}.md`),
            sourceUrl: input.githubUrl
          };
        }
      }
    };

    const originalCwd = process.cwd();
    process.chdir(os.tmpdir());
    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/download/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          githubUrls: [
            'https://github.com/example/one/blob/main/README.md',
            'https://github.com/example/two/blob/main/README.md'
          ],
          outputRoot: 'downloads'
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.type, 'download');
      assert.equal(response.body.job.items.length, 2);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.status, 200);
        assert.deepEqual(
          itemsResponse.body.items.map((item) => item.status),
          ['completed', 'completed']
        );
        assert.deepEqual(
          itemsResponse.body.items.map((item) => item.result.markdownPath),
          [
            path.join(projectRoot, 'downloads', '1.md'),
            path.join(projectRoot, 'downloads', '2.md')
          ]
        );

        const jobResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}`);
        assert.equal(jobResponse.body.job.status, 'completed');
      });

      assert.deepEqual(
        calls.map((call) => ({ githubUrl: call.githubUrl, outputRoot: call.outputRoot })),
        [
          {
            githubUrl: 'https://github.com/example/one/blob/main/README.md',
            outputRoot: path.join(projectRoot, 'downloads')
          },
          {
            githubUrl: 'https://github.com/example/two/blob/main/README.md',
            outputRoot: path.join(projectRoot, 'downloads')
          }
        ]
      );
    } finally {
      process.chdir(originalCwd);
      await close();
    }
  });
});

test('POST /api/download/jobs 允许项目外绝对 outputRoot', async () => {
  await withTempDir(async (projectRoot) => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'pdf-to-markdown-download-outside-'));
    const calls = [];
    const services = {
      download: {
        run: async (input) => {
          calls.push(input);
          return {
            markdownPath: path.join(input.outputRoot, 'README.md'),
            sourceUrl: input.githubUrl
          };
        }
      }
    };

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/download/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          githubUrls: ['https://github.com/example/repo/blob/main/README.md'],
          outputRoot: outsideRoot
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.payload.outputRoot, outsideRoot);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.status, 200);
        assert.equal(itemsResponse.body.items[0].status, 'completed');
        assert.equal(itemsResponse.body.items[0].result.markdownPath, path.join(outsideRoot, 'README.md'));
      });

      assert.equal(calls[0].outputRoot, outsideRoot);
    } finally {
      await close();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('POST /api/clean/jobs 会创建批量清洗任务', async () => {
  await withTempDir(async (projectRoot) => {
    const services = {
      clean: {
        run: async ({ markdownPath, rulesFile }) => ({
          outputPath: `${markdownPath}.cleaned.md`,
          rulesFile
        })
      }
    };

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const firstPath = path.join(projectRoot, 'docs', 'one.md');
      const secondPath = path.join(projectRoot, 'docs', 'two.md');
      await mkdir(path.dirname(firstPath), { recursive: true });
      await writeFile(firstPath, '# one\n', 'utf8');
      await writeFile(secondPath, '# two\n', 'utf8');

      const response = await requestJson(origin, '/api/clean/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [firstPath, secondPath],
          rulesFile: path.join(projectRoot, 'rules.json')
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.type, 'clean');
      assert.equal(response.body.job.items.length, 2);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.deepEqual(
          itemsResponse.body.items.map((item) => item.result.outputPath),
          [`${firstPath}.cleaned.md`, `${secondPath}.cleaned.md`]
        );

        const jobResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}`);
        assert.equal(jobResponse.body.job.status, 'completed');
      });
    } finally {
      await close();
    }
  });
});

test('POST /api/clean/jobs 在多文件加单 outputPath 时返回 400', async () => {
  await withTempDir(async (projectRoot) => {
    const firstPath = path.join(projectRoot, 'docs', 'one.md');
    const secondPath = path.join(projectRoot, 'docs', 'two.md');
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, '# one\n', 'utf8');
    await writeFile(secondPath, '# two\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/clean/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [firstPath, secondPath],
          rulesFile: path.join(projectRoot, 'rules.json'),
          outputPath: path.join(projectRoot, 'output', 'same.md')
        })
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /outputPath/i);
    } finally {
      await close();
    }
  });
});

test('GET /api/clean/rules 会读取并展示正则规则与内置处理', async () => {
  await withTempDir(async (projectRoot) => {
    const rulesFile = path.join(projectRoot, 'rules.json');
    await writeFile(rulesFile, JSON.stringify([
      {
        id: 'remove-source',
        name: '删除 Source 行',
        pattern: '^Source:.*$',
        flags: 'gm',
        replacement: '',
        enabled: true
      }
    ]), 'utf8');

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, `/api/clean/rules?rulesFile=${encodeURIComponent('rules.json')}`);

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.rulesFile, rulesFile);
      assert.deepEqual(response.body.rules[0], {
        id: 'remove-source',
        name: '删除 Source 行',
        pattern: '^Source:.*$',
        flags: 'gm',
        replacement: '',
        enabled: true
      });
      assert.equal(Array.isArray(response.body.builtInRules), true);
      assert.equal(response.body.builtInRules[0].id, 'case-heading-renumber');
    } finally {
      await close();
    }
  });
});

test('POST /api/clean/rules 会保存可视化编辑后的正则规则', async () => {
  await withTempDir(async (projectRoot) => {
    const rulesFile = path.join(projectRoot, 'rules.json');
    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/clean/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rulesFile: 'rules.json',
          rules: [
            {
              id: 'trim-trailing-space',
              name: '删除行尾空白',
              pattern: '[ \\t]+$',
              flags: 'gm',
              replacement: '',
              enabled: true
            }
          ]
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.rulesFile, rulesFile);

      const savedRules = JSON.parse(await readFile(rulesFile, 'utf8'));
      assert.deepEqual(savedRules, [
        {
          id: 'trim-trailing-space',
          name: '删除行尾空白',
          pattern: '[ \\t]+$',
          flags: 'gm',
          replacement: '',
          enabled: true
        }
      ]);
    } finally {
      await close();
    }
  });
});

test('POST /api/translate/jobs 会创建批量翻译任务', async () => {
  await withTempDir(async (projectRoot) => {
    const calls = [];
    const services = {
      translate: {
        run: async (input) => {
          calls.push(input);
          return {
            outputPath: `${input.markdownPath}.translated.${input.targetLanguage}.md`,
            targetLanguage: input.targetLanguage
          };
        }
      }
    };

    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [markdownPath],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key'
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.type, 'translate');
      assert.equal(response.body.job.items.length, 1);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.body.items[0].status, 'completed');
        assert.equal(
          itemsResponse.body.items[0].result.outputPath,
          `${markdownPath}.translated.zh-CN.md`
        );

        const jobResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}`);
        assert.equal(jobResponse.body.job.status, 'completed');
      });

      assert.equal(calls[0].apiKey, 'test-api-key');
      assert.equal(calls[0].targetLanguage, 'zh-CN');
    } finally {
      await close();
    }
  });
});

test('POST /api/translate/jobs 允许项目外 outputPath', async () => {
  await withTempDir(async (projectRoot) => {
    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');
    const services = {
      translate: {
        run: async (input) => ({
          outputPath: input.outputPath
        })
      }
    };

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const outsideOutput = path.resolve(projectRoot, '..', 'outside.md');

      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [markdownPath],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key',
          outputPath: outsideOutput
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.payload.outputPath, outsideOutput);
    } finally {
      await close();
    }
  });
});

test('POST /api/translate/jobs 允许项目外 cacheFile', async () => {
  await withTempDir(async (projectRoot) => {
    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');
    const services = {
      translate: {
        run: async (input) => ({
          cacheFile: input.cacheFile
        })
      }
    };

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const outsideCache = path.resolve(projectRoot, '..', 'outside-cache.json');

      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [markdownPath],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key',
          cacheFile: outsideCache
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.payload.cacheFile, outsideCache);
    } finally {
      await close();
    }
  });
});

test('POST /api/translate/jobs 在 projectRoot 不等于 cwd 时按 projectRoot 解析相对路径', async () => {
  await withTempDir(async (projectRoot) => {
    const calls = [];
    const services = {
      translate: {
        run: async (input) => {
          calls.push(input);
          return {
            outputPath: input.outputPath,
            cacheFile: input.cacheFile
          };
        }
      }
    };

    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');

    const originalCwd = process.cwd();
    process.chdir(os.tmpdir());
    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: ['docs/one.md'],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key',
          outputPath: 'output/translated.md',
          cacheFile: 'cache/translate.json'
        })
      });

      assert.equal(response.status, 200);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.body.items[0].status, 'completed');
      });

      assert.equal(calls[0].markdownPath, path.join(projectRoot, 'docs', 'one.md'));
      assert.equal(calls[0].outputPath, path.join(projectRoot, 'output', 'translated.md'));
      assert.equal(calls[0].cacheFile, path.join(projectRoot, 'cache', 'translate.json'));
    } finally {
      process.chdir(originalCwd);
      await close();
    }
  });
});

test('POST /api/translate/jobs 在多文件加单 outputPath 时返回 400', async () => {
  await withTempDir(async (projectRoot) => {
    const firstPath = path.join(projectRoot, 'docs', 'one.md');
    const secondPath = path.join(projectRoot, 'docs', 'two.md');
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, '# one\n', 'utf8');
    await writeFile(secondPath, '# two\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [firstPath, secondPath],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key',
          outputPath: path.join(projectRoot, 'output', 'same.md')
        })
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /outputPath/i);
    } finally {
      await close();
    }
  });
});

test('POST /api/translate/jobs 在 service 失败时会把子项和父 job 都标记为 failed', async () => {
  await withTempDir(async (projectRoot) => {
    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');

    const services = {
      translate: {
        run: async () => {
          throw new Error('translator offline');
        }
      }
    };

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/translate/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [markdownPath],
          targetLanguage: 'zh-CN',
          apiKey: 'test-api-key'
        })
      });

      assert.equal(response.status, 200);

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.body.items[0].status, 'failed');
        assert.match(itemsResponse.body.items[0].error, /translator offline/);

        const jobResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}`);
        assert.equal(jobResponse.body.job.status, 'failed');
      });
    } finally {
      await close();
    }
  });
});

test('POST /api/export/jobs 会创建批量导出任务', async () => {
  await withTempDir(async (projectRoot) => {
    const services = {
      export: {
        run: async ({ markdownPath, appendLicenseNote, licenseNote, watermarkText }) => ({
          htmlPath: markdownPath.replace(/\.md$/i, '.html'),
          pdfPath: markdownPath.replace(/\.md$/i, '.pdf'),
          appendLicenseNote,
          licenseNote,
          watermarkText
        })
      }
    };

    const markdownPath = path.join(projectRoot, 'docs', 'one.md');
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, '# one\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot, services });

    try {
      const response = await requestJson(origin, '/api/export/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdownPaths: [markdownPath],
          appendLicenseNote: true,
          licenseNote: '仅供个人学习与整理使用。',
          watermarkText: 'AI灵感仓库'
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.job.type, 'export');

      await waitFor(async () => {
        const itemsResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}/items`);
        assert.equal(itemsResponse.body.items[0].status, 'completed');
        assert.equal(
          itemsResponse.body.items[0].result.htmlPath,
          markdownPath.replace(/\.md$/i, '.html')
        );
        assert.equal(
          itemsResponse.body.items[0].result.pdfPath,
          markdownPath.replace(/\.md$/i, '.pdf')
        );
        assert.equal(itemsResponse.body.items[0].result.watermarkText, 'AI灵感仓库');

        const jobResponse = await requestJson(origin, `/api/jobs/${response.body.job.id}`);
        assert.equal(jobResponse.body.job.status, 'completed');
        assert.equal(jobResponse.body.job.payload.watermarkText, 'AI灵感仓库');
      });
    } finally {
      await close();
    }
  });
});

test('/api/files/scan-markdown 扫描顶层目录下的 Markdown 文件', async () => {
  await withTempDir(async (projectRoot) => {
    const docsDir = path.join(projectRoot, 'docs');
    await mkdir(path.join(docsDir, 'nested'), { recursive: true });
    await mkdir(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(docsDir, 'README.md'), '# root\n', 'utf8');
    await writeFile(path.join(docsDir, 'nested', 'guide.md'), '# guide\n', 'utf8');
    await writeFile(path.join(projectRoot, 'node_modules', 'pkg', 'skip.md'), '# skip\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/files/scan-markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topLevelDir: docsDir })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.files.length, 2);
      assert.deepEqual(
        response.body.files.map((entry) => entry.relativePath).sort(),
        ['README.md', 'nested/guide.md']
      );
    } finally {
      await close();
    }
  });
});

test('/api/files/scan-markdown 的非法 JSON 返回 400', async () => {
  const { origin, close } = await startServer();

  try {
    const response = await requestJson(origin, '/api/files/scan-markdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid-json'
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
  } finally {
    await close();
  }
});

test('/api/files/scan-markdown 的非对象 JSON 返回 400', async () => {
  const { origin, close } = await startServer();

  try {
    for (const body of ['null', '[]']) {
      const response = await requestJson(origin, '/api/files/scan-markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /json object/i);
    }
  } finally {
    await close();
  }
});

test('/api/files/scan-markdown 会按 projectRoot 解析相对 topLevelDir', async () => {
  await withTempDir(async (projectRoot) => {
    const docsDir = path.join(projectRoot, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, 'README.md'), '# root\n', 'utf8');

    const originalCwd = process.cwd();
    process.chdir(os.tmpdir());

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/files/scan-markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topLevelDir: 'docs' })
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.topLevelDir, docsDir);
      assert.deepEqual(
        response.body.files.map((entry) => entry.relativePath),
        ['README.md']
      );
    } finally {
      process.chdir(originalCwd);
      await close();
    }
  });
});

test('/api/files/scan-markdown 允许扫描项目外的绝对目录', async () => {
  await withTempDir(async (projectRoot) => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'pdf-to-markdown-outside-'));

    try {
      await mkdir(path.join(outsideRoot, 'nested'), { recursive: true });
      await writeFile(path.join(outsideRoot, 'external.md'), '# external\n', 'utf8');
      await writeFile(path.join(outsideRoot, 'nested', 'child.md'), '# child\n', 'utf8');

      const { origin, close } = await startServer({ projectRoot });

      try {
        const response = await requestJson(origin, '/api/files/scan-markdown', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topLevelDir: outsideRoot })
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.topLevelDir, outsideRoot);
        assert.deepEqual(
          response.body.files.map((entry) => entry.relativePath).sort(),
          ['external.md', 'nested/child.md']
        );
      } finally {
        await close();
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('/api/files/scan-markdown 对项目内不存在的 topLevelDir 返回 404', async () => {
  await withTempDir(async (projectRoot) => {
    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/files/scan-markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topLevelDir: 'missing-dir' })
      });

      assert.equal(response.status, 404);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /not found/i);
    } finally {
      await close();
    }
  });
});

test('/api/files/scan-markdown 对存在但不是目录的 topLevelDir 返回 400', async () => {
  await withTempDir(async (projectRoot) => {
    const filePath = path.join(projectRoot, 'README.md');
    await writeFile(filePath, '# root\n', 'utf8');

    const { origin, close } = await startServer({ projectRoot });

    try {
      const response = await requestJson(origin, '/api/files/scan-markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topLevelDir: 'README.md' })
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /directory/i);
    } finally {
      await close();
    }
  });
});

test('/api/jobs/:jobId 与 /api/jobs/:jobId/items 返回任务及子项', async () => {
  const jobStore = createJobStore();
  const job = jobStore.createJob({
    type: 'download',
    status: 'running',
    items: [
      { id: 'item-1', name: 'README.md', status: 'completed' },
      { id: 'item-2', name: 'guide.md', status: 'pending' }
    ]
  });

  const { origin, close } = await startServer({ jobStore });

  try {
    const jobResponse = await requestJson(origin, `/api/jobs/${job.id}`);
    assert.equal(jobResponse.status, 200);
    assert.equal(jobResponse.body.ok, true);
    assert.equal(jobResponse.body.job.id, job.id);
    assert.equal(jobResponse.body.job.status, 'running');

    const itemsResponse = await requestJson(origin, `/api/jobs/${job.id}/items`);
    assert.equal(itemsResponse.status, 200);
    assert.equal(itemsResponse.body.ok, true);
    assert.equal(itemsResponse.body.items.length, 2);
    assert.deepEqual(
      itemsResponse.body.items.map((item) => item.id),
      ['item-1', 'item-2']
    );
  } finally {
    await close();
  }
});

test('未知任务返回 404', async () => {
  const { origin, close } = await startServer();

  try {
    const response = await requestJson(origin, '/api/jobs/missing-job');
    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /Job not found/);
  } finally {
    await close();
  }
});

test('/api/jobs/:jobId/items 的多余路径段返回 404', async () => {
  const jobStore = createJobStore();
  const job = jobStore.createJob({
    type: 'download',
    items: [{ id: 'item-1', status: 'pending' }]
  });

  const { origin, close } = await startServer({ jobStore });

  try {
    const response = await requestJson(origin, `/api/jobs/${job.id}/items/extra`);
    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
  } finally {
    await close();
  }
});

test('/api/jobs 的畸形 URL 编码返回 400', async () => {
  const { origin, close } = await startServer();

  try {
    const response = await requestRawPath(origin, '/api/jobs/%E0%A4%A');
    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /invalid/i);
  } finally {
    await close();
  }
});
