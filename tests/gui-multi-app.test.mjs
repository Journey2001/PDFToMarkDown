import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { scanMarkdownInto, getSelectedMarkdownPaths } from '../apps/shared/markdown-picker.js';
import { pollJobUntilSettled, JobPollingTimeoutError, JobPollingUnavailableError } from '../apps/shared/jobs.js';
import { RequestTimeoutError } from '../apps/shared/api.js';
import { normalizeGithubUrls, clearJobResult, EMPTY_JOB_SUMMARY, IDLE_LOG_TEXT, loadDefaults, initializeDownloadApp } from '../apps/download-ui/app.js';
import { buildCleanPayload, initializeCleanApp } from '../apps/clean-ui/app.js';
import { buildTranslatePayload, initializeTranslateApp } from '../apps/translate-ui/app.js';
import { initializeExportApp } from '../apps/export-ui/app.js';
import { createAppServer } from '../server/server.mjs';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

async function startServer(options = {}) {
  const server = createAppServer(options);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function requestText(origin, pathname) {
  const response = await fetch(new URL(pathname, origin));

  return {
    status: response.status,
    text: await response.text(),
    headers: Object.fromEntries(response.headers.entries())
  };
}

function createFakeElements() {
  return {
    jobIdOutput: { textContent: 'job-123' },
    jobStateOutput: { textContent: 'completed' },
    jobCountOutput: { textContent: '2' },
    jobSummaryOutput: { textContent: 'old summary' },
    jobLogOutput: { textContent: 'old log' }
  };
}

function createEventTarget(initial = {}) {
  const listeners = new Map();

  return {
    ...initial,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    async trigger(type, event = {}) {
      const handler = listeners.get(type);
      if (!handler) {
        throw new Error(`Missing listener: ${type}`);
      }

      return handler({
        preventDefault() {},
        ...event
      });
    }
  };
}

function createSelectElement() {
  const options = [];
  const element = createEventTarget({
    innerHTML: '',
    options,
    ownerDocument: {
      createElement(tagName) {
        assert.equal(tagName, 'option');
        return {
          value: '',
          textContent: '',
          selected: false
        };
      }
    },
    append(option) {
      options.push(option);
    }
  });

  Object.defineProperty(element, 'selectedOptions', {
    get() {
      return options.filter((option) => option.selected);
    }
  });

  return element;
}

function createFakeDocument(entries) {
  return {
    querySelector(selector) {
      return entries[selector] ?? null;
    },
    querySelectorAll(selector) {
      return entries[selector] ?? [];
    }
  };
}

function createResultOutputs() {
  return {
    '#status-text': { textContent: '' },
    '#job-status-badge': { className: '', textContent: '' },
    '#job-id': { textContent: '-' },
    '#job-state': { textContent: '-' },
    '#job-count': { textContent: '0' },
    '#job-summary': { textContent: '' },
    '#job-log': { textContent: '' }
  };
}

test('download-ui 页面保留多 URL 输入、保存目录和任务结果区域', async () => {
  const html = await readText('apps/download-ui/index.html');

  assert.match(html, /data-app="download"/);
  assert.match(html, /<form[^>]+id="download-form"/);
  assert.match(html, /<textarea[^>]+name="githubUrls"/);
  assert.match(html, /<input[^>]+name="outputRoot"/);
  assert.match(html, /提交下载任务/);
  assert.match(html, /id="job-result"/);
});

test('pollJobUntilSettled 在任务完成时返回最终 job 并回调更新', async () => {
  const seen = [];
  let nowMs = 0;
  let callCount = 0;

  const job = await pollJobUntilSettled('job-1', {
    intervalMs: 5,
    timeoutMs: 50,
    requestTimeoutMs: 10,
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    getJob: async () => {
      callCount += 1;
      nowMs += 1;
      return {
        job: {
          id: 'job-1',
          status: callCount >= 2 ? 'completed' : 'running'
        }
      };
    },
    onUpdate(jobSnapshot) {
      seen.push(jobSnapshot.status);
    }
  });

  assert.equal(job.status, 'completed');
  assert.deepEqual(seen, ['running', 'completed']);
});

test('pollJobUntilSettled 在总超时耗尽时抛出超时错误，即使单次请求只是暂时超时', async () => {
  let nowMs = 0;

  await assert.rejects(
    pollJobUntilSettled('job-timeout', {
      intervalMs: 5,
      timeoutMs: 20,
      requestTimeoutMs: 5,
      maxConsecutiveErrors: 10,
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
      getJob: async () => {
        nowMs += 6;
        throw new RequestTimeoutError('Request timed out: /api/jobs/job-timeout');
      }
    }),
    (error) => {
      assert.equal(error instanceof JobPollingTimeoutError, true);
      assert.match(error.message, /Job polling timed out/);
      return true;
    }
  );
});

test('pollJobUntilSettled 对有限次暂时失败进行重试，超过阈值后抛出非终局轮询错误', async () => {
  let nowMs = 0;
  const seenErrors = [];

  await assert.rejects(
    pollJobUntilSettled('job-unavailable', {
      intervalMs: 5,
      timeoutMs: 100,
      requestTimeoutMs: 5,
      maxConsecutiveErrors: 2,
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
      getJob: async () => {
        nowMs += 1;
        throw new Error('socket hang up');
      },
      onRetryError(error, context) {
        seenErrors.push([error.message, context.consecutiveErrors]);
      }
    }),
    (error) => {
      assert.equal(error instanceof JobPollingUnavailableError, true);
      assert.match(error.message, /task may still be running in background/i);
      return true;
    }
  );

  assert.deepEqual(seenErrors, [
    ['socket hang up', 1],
    ['socket hang up', 2]
  ]);
});

test('normalizeGithubUrls 会裁剪空白并忽略空行', () => {
  assert.deepEqual(
    normalizeGithubUrls('\n https://github.com/a/repo/blob/main/README.md \r\n\r\nhttps://github.com/b/repo/blob/main/docs.md  \n'),
    [
      'https://github.com/a/repo/blob/main/README.md',
      'https://github.com/b/repo/blob/main/docs.md'
    ]
  );
});

test('clearJobResult 会清空旧任务展示，避免上一轮结果残留', () => {
  const elements = createFakeElements();

  clearJobResult(elements);

  assert.equal(elements.jobIdOutput.textContent, '-');
  assert.equal(elements.jobStateOutput.textContent, '-');
  assert.equal(elements.jobCountOutput.textContent, '0');
  assert.equal(elements.jobSummaryOutput.textContent, EMPTY_JOB_SUMMARY);
  assert.equal(elements.jobLogOutput.textContent, IDLE_LOG_TEXT);
});

test('loadDefaults 会填充默认下载目录并提示可使用绝对路径', async () => {
  const elements = {
    outputRootInput: {
      value: '',
      placeholder: ''
    },
    jobLogOutput: {
      textContent: ''
    }
  };

  await loadDefaults(elements, {
    getConfig: async () => ({
      projectRoot: 'D:/AIPainting/PDFToMarkDown'
    })
  });

  assert.equal(elements.outputRootInput.value, 'downloads');
  assert.match(elements.outputRootInput.placeholder, /D:\\Docs\\Markdown/);
  assert.doesNotMatch(elements.outputRootInput.placeholder, /项目根目录/);
});

test('package.json 保留 GUI 多应用测试脚本', async () => {
  const packageJson = JSON.parse(await readText('package.json'));

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.scripts['test:gui'], 'node --test tests/gui-multi-app.test.mjs');
});

test('clean-ui 页面包含 scanRoot、rulesFile、规则可视化和 markdown 多选列表', async () => {
  const html = await readText('apps/clean-ui/index.html');

  assert.match(html, /<input[^>]+name="scanRoot"/);
  assert.match(html, /<input[^>]+name="rulesFile"/);
  assert.match(html, /id="cleanup-rules-list"/);
  assert.match(html, /id="save-rules-button"/);
  assert.match(html, /正则规则/);
  assert.match(html, /内置处理/);
  assert.match(html, /<select[^>]+id="markdown-files"[^>]*multiple/);
  assert.match(html, /提交清洗任务/);
});

test('clean-ui 用可折叠 details 渲染每条正则规则', async () => {
  const script = await readText('apps/clean-ui/app.js');

  assert.match(script, /createElement\('details'\)/);
  assert.match(script, /createElement\('summary'\)/);
  assert.match(script, /rule-card-summary/);
  assert.match(script, /rule-summary-title/);
});

test('translate-ui 页面包含翻译参数字段与 markdown 多选列表', async () => {
  const html = await readText('apps/translate-ui/index.html');

  assert.match(html, /<input[^>]+name="scanRoot"/);
  assert.match(html, /<select[^>]+id="markdown-files"[^>]*multiple/);
  assert.match(html, /name="targetLanguage"/);
  assert.match(html, /name="translateModel"/);
  assert.match(html, /name="deepseekApiKey"/);
  assert.match(html, /提交翻译任务/);
});

test('export-ui 页面包含目录扫描、导出选项和提交按钮', async () => {
  const html = await readText('apps/export-ui/index.html');

  assert.match(html, /<input[^>]+name="scanRoot"/);
  assert.match(html, /<select[^>]+id="markdown-files"[^>]*multiple/);
  assert.match(html, /name="watermarkText"/);
  assert.match(html, /<select[^>]+name="lang"/);
  assert.match(html, /name="appendLicenseNote"/);
  assert.match(html, /name="licenseNote"/);
  assert.doesNotMatch(html, /name="stripSources"/);
  assert.match(html, /提交导出任务/);
});

test('scanMarkdownInto 会填充扫描结果并默认全选', async () => {
  const selectElement = {
    innerHTML: 'stale',
    options: [],
    ownerDocument: {
      createElement(tagName) {
        assert.equal(tagName, 'option');
        return {
          value: '',
          textContent: '',
          selected: false
        };
      }
    },
    append(option) {
      this.options.push(option);
    }
  };

  const files = await scanMarkdownInto(selectElement, 'docs', {
    scanMarkdown: async (payload) => {
      assert.deepEqual(payload, { topLevelDir: 'docs' });
      return {
        files: [
          { path: 'docs/a.md', relativePath: 'docs/a.md' },
          { path: 'docs/nested/b.md', relativePath: 'docs/nested/b.md' }
        ]
      };
    }
  });

  assert.equal(selectElement.innerHTML, '');
  assert.deepEqual(files.map((file) => file.path), ['docs/a.md', 'docs/nested/b.md']);
  assert.deepEqual(selectElement.options, [
    { value: 'docs/a.md', textContent: 'docs/a.md', selected: true },
    { value: 'docs/nested/b.md', textContent: 'docs/nested/b.md', selected: true }
  ]);
});

test('getSelectedMarkdownPaths 只返回被选中的文件路径', () => {
  const selectElement = {
    selectedOptions: [
      { value: 'docs/a.md' },
      { value: 'docs/b.md' }
    ]
  };

  assert.deepEqual(getSelectedMarkdownPaths(selectElement), ['docs/a.md', 'docs/b.md']);
});

test('buildCleanPayload 会拒绝多文件批量时传统一 outputPath', () => {
  assert.throws(
    () => buildCleanPayload({
      markdownPaths: ['docs/a.md', 'docs/b.md'],
      rulesFile: 'config/cleanup-rules.json',
      outputPath: 'output/cleaned.md'
    }),
    /多文件批量清洗时不能填写统一输出路径/
  );
});

test('buildTranslatePayload 会拒绝多文件批量时传统一 outputPath', () => {
  assert.throws(
    () => buildTranslatePayload({
      markdownPaths: ['docs/a.md', 'docs/b.md'],
      apiKey: 'sk-demo',
      outputPath: 'output/translated.md',
      targetLanguage: 'zh-CN'
    }),
    /多文件批量翻译时不能填写统一输出路径/
  );
});

test('buildTranslatePayload 不会持久化或依赖本地存储中的 apiKey', () => {
  const payload = buildTranslatePayload({
    markdownPaths: ['docs/a.md'],
    apiKey: 'sk-demo',
    targetLanguage: 'zh-CN',
    model: 'deepseek-chat'
  });

  assert.equal(payload.apiKey, 'sk-demo');
  assert.equal(payload.model, 'deepseek-chat');
});

test('initializeDownloadApp 会提交下载任务并渲染最终结果', async () => {
  const form = createEventTarget();
  const entries = {
    '#download-form': form,
    '#github-urls': { value: 'https://github.com/a/repo/blob/main/README.md' },
    '#output-root': { value: 'downloads', placeholder: '' },
    '#submit-download': { disabled: false },
    ...createResultOutputs()
  };
  const document = createFakeDocument(entries);

  initializeDownloadApp(document, {
    getConfig: async () => ({ projectRoot: 'D:/AIPainting/PDFToMarkDown' }),
    createJob: async (payload) => {
      assert.deepEqual(payload, {
        githubUrls: ['https://github.com/a/repo/blob/main/README.md'],
        outputRoot: 'downloads'
      });
      return {
        job: {
          id: 'job-download-1',
          status: 'queued',
          items: [
            {
              githubUrl: payload.githubUrls[0],
              status: 'queued'
            }
          ]
        }
      };
    },
    pollJob: async (jobId, options) => {
      assert.equal(jobId, 'job-download-1');
      options.onUpdate({
        id: 'job-download-1',
        status: 'running',
        items: [
          {
            githubUrl: 'https://github.com/a/repo/blob/main/README.md',
            status: 'running'
          }
        ]
      });
      return {
        id: 'job-download-1',
        status: 'completed',
        items: [
          {
            githubUrl: 'https://github.com/a/repo/blob/main/README.md',
            status: 'completed',
            result: {
              markdownPath: 'downloads/README.md'
            }
          }
        ]
      };
    }
  });

  await form.trigger('submit');

  assert.equal(entries['#job-state'].textContent, 'completed');
  assert.match(entries['#job-summary'].textContent, /downloads\/README\.md/);
  assert.match(entries['#status-text'].textContent, /下载任务已完成/);
});

test('initializeCleanApp 会扫描目录、提交清洗任务并渲染最终结果', async () => {
  const scanForm = createEventTarget();
  const runForm = createEventTarget();
  const markdownSelect = createSelectElement();
  const entries = {
    '#scan-form': scanForm,
    '#clean-form': runForm,
    '#scan-root': { value: 'output', placeholder: '' },
    '#rules-file': { value: 'config/cleanup-rules.json' },
    '#clean-output-path': { value: '' },
    '#markdown-files': markdownSelect,
    '#scan-button': { disabled: false },
    '#submit-clean': { disabled: false },
    ...createResultOutputs()
  };
  const document = createFakeDocument(entries);
  let seenPayload = null;

  initializeCleanApp(document, {
    getConfig: async () => ({ projectRoot: 'D:/AIPainting/PDFToMarkDown' }),
    scanMarkdown: async (selectElement, scanRoot) => {
      assert.equal(scanRoot, 'output');
      selectElement.append({ value: 'output/a.md', textContent: 'a.md', selected: true });
      return [{ path: 'output/a.md', relativePath: 'a.md' }];
    },
    createJob: async (payload) => {
      seenPayload = payload;
      return {
        job: {
          id: 'job-clean-1',
          status: 'queued',
          items: [{ markdownPath: 'output/a.md', status: 'queued' }]
        }
      };
    },
    pollJob: async () => ({
      id: 'job-clean-1',
      status: 'completed',
      items: [
        {
          markdownPath: 'output/a.md',
          status: 'completed',
          result: { outputPath: 'output/a.cleaned.md' }
        }
      ]
    })
  });

  await scanForm.trigger('submit');
  await runForm.trigger('submit');

  assert.deepEqual(seenPayload, {
    markdownPaths: ['output/a.md'],
    rulesFile: 'config/cleanup-rules.json'
  });
  assert.equal(entries['#job-state'].textContent, 'completed');
  assert.match(entries['#job-summary'].textContent, /output\/a\.cleaned\.md/);
});

test('initializeTranslateApp 会扫描目录、提交翻译任务并渲染最终结果', async () => {
  const scanForm = createEventTarget();
  const runForm = createEventTarget();
  const markdownSelect = createSelectElement();
  const entries = {
    '#scan-form': scanForm,
    '#translate-form': runForm,
    '#scan-root': { value: 'output', placeholder: '' },
    '#markdown-files': markdownSelect,
    '#target-language': createEventTarget({ value: 'zh-CN' }),
    '#translate-model': createEventTarget({ value: 'deepseek-chat' }),
    '#translate-concurrency': createEventTarget({ value: '6' }),
    '#translate-batch-size': createEventTarget({ value: '1' }),
    '#deepseek-api-key': createEventTarget({ value: 'sk-demo' }),
    '#translate-output-path': { value: '' },
    '#translate-cache-file': createEventTarget({ value: 'output/.translation-cache.json' }),
    '#scan-button': { disabled: false },
    '#submit-translate': { disabled: false },
    ...createResultOutputs()
  };
  const document = createFakeDocument(entries);
  let seenPayload = null;

  initializeTranslateApp(document, {
    getConfig: async () => ({ projectRoot: 'D:/AIPainting/PDFToMarkDown' }),
    scanMarkdown: async (selectElement) => {
      selectElement.append({ value: 'output/a.md', textContent: 'a.md', selected: true });
      return [{ path: 'output/a.md', relativePath: 'a.md' }];
    },
    createJob: async (payload) => {
      seenPayload = payload;
      return {
        job: {
          id: 'job-translate-1',
          status: 'queued',
          items: [{ markdownPath: 'output/a.md', status: 'queued' }]
        }
      };
    },
    pollJob: async () => ({
      id: 'job-translate-1',
      status: 'completed',
      items: [
        {
          markdownPath: 'output/a.md',
          status: 'completed',
          result: { outputPath: 'output/a.translated.zh-CN.md' }
        }
      ]
    })
  });

  await scanForm.trigger('submit');
  entries['#translate-concurrency'].value = '6';
  entries['#translate-batch-size'].value = '1';
  entries['#translate-cache-file'].value = 'output/.translation-cache.json';
  await runForm.trigger('submit');

  assert.deepEqual(seenPayload, {
    markdownPaths: ['output/a.md'],
    apiKey: 'sk-demo',
    targetLanguage: 'zh-CN',
    model: 'deepseek-chat',
    concurrency: 6,
    batchSize: 1,
    cacheFile: 'output/.translation-cache.json'
  });
  assert.equal(entries['#job-state'].textContent, 'completed');
  assert.match(entries['#job-summary'].textContent, /output\/a\.translated\.zh-CN\.md/);
});

test('initializeExportApp 会扫描目录、提交导出任务并渲染最终结果', async () => {
  const scanForm = createEventTarget();
  const runForm = createEventTarget();
  const markdownSelect = createSelectElement();
  const entries = {
    '#scan-form': scanForm,
    '#export-form': runForm,
    '#scan-root': { value: 'output', placeholder: '' },
    '#markdown-files': markdownSelect,
    '#watermark-text': { value: '' },
    '#lang': { value: 'zh-CN' },
    '#append-license-note': { checked: true },
    '#license-note': { value: '仅供个人学习与整理使用。' },
    '#scan-button': { disabled: false },
    '#submit-export': { disabled: false },
    ...createResultOutputs()
  };
  const document = createFakeDocument(entries);
  let seenPayload = null;

  initializeExportApp(document, {
    getConfig: async () => ({ projectRoot: 'D:/AIPainting/PDFToMarkDown' }),
    scanMarkdown: async (selectElement) => {
      selectElement.append({ value: 'output/a.md', textContent: 'a.md', selected: true });
      return [{ path: 'output/a.md', relativePath: 'a.md' }];
    },
    createJob: async (payload) => {
      seenPayload = payload;
      return {
        job: {
          id: 'job-export-1',
          status: 'queued',
          items: [{ markdownPath: 'output/a.md', status: 'queued' }]
        }
      };
    },
    pollJob: async () => ({
      id: 'job-export-1',
      status: 'completed',
      items: [
        {
          markdownPath: 'output/a.md',
          status: 'completed',
          result: {
            htmlPath: 'output/a.html',
            pdfPath: 'output/a.pdf'
          }
        }
      ]
    })
  });

  await scanForm.trigger('submit');
  await runForm.trigger('submit');

  assert.deepEqual(seenPayload, {
    markdownPaths: ['output/a.md'],
    lang: 'zh-CN',
    watermarkText: '',
    appendLicenseNote: true,
    licenseNote: '仅供个人学习与整理使用。'
  });
  assert.equal(entries['#job-state'].textContent, 'completed');
  assert.match(entries['#job-summary'].textContent, /output\/a\.html/);
  assert.match(entries['#job-summary'].textContent, /output\/a\.pdf/);
});

test('shell-ui 页面包含 download clean translate export 四个分页入口', async () => {
  const html = await readText('apps/shell-ui/index.html');

  assert.match(html, /PDFToMarkDown 控制台/);
  assert.match(html, /<nav[^>]+class="shell-nav"/);
  assert.match(html, /data-app="download"/);
  assert.match(html, /data-app="clean"/);
  assert.match(html, /data-app="translate"/);
  assert.match(html, /data-app="export"/);
  assert.match(html, /scrolling="no"/);
  assert.match(html, /<iframe[^>]+id="app-frame"/);
  assert.doesNotMatch(html, /shell-grid/);
});

test('initializeShellApp 默认加载 download 并支持基于 data-app 的分页切换', async () => {
  const { initializeShellApp } = await import('../apps/shell-ui/app.js');
  const frame = { src: '', style: {} };
  const frameTitle = { textContent: '' };
  const frameRoute = { textContent: '' };
  const buttons = ['download', 'clean', 'translate', 'export'].map((appId) => ({
    dataset: { app: appId },
    classList: {
      toggled: new Map(),
      toggle(name, value) {
        this.toggled.set(name, value);
      }
    },
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    addEventListener(type, handler) {
      if (type === 'click') {
        this.click = handler;
      }
    }
  }));
  const fakeDocument = {
    querySelector(selector) {
      if (selector === '#app-frame') {
        return frame;
      }
      if (selector === '#frame-title') {
        return frameTitle;
      }
      if (selector === '#frame-route') {
        return frameRoute;
      }
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-app]');
      return buttons;
    }
  };

  const app = initializeShellApp(fakeDocument);

  assert.equal(frame.src, '/download');
  assert.equal(frameTitle.textContent, '下载');
  assert.equal(frameRoute.textContent, '/download');

  buttons[2].click();
  assert.equal(frame.src, '/translate');
  assert.equal(frameTitle.textContent, '翻译');
  assert.equal(frameRoute.textContent, '/translate');
  assert.equal(frame.style.height, '760px');
  assert.equal(app !== null, true);
});

test('createAppServer 会把根路径和四个子路径映射到对应多应用入口，并暴露共享资源', async () => {
  const { origin, close } = await startServer({
    projectRoot: fileURLToPath(new URL('..', import.meta.url))
  });

  try {
    const [shellPage, shellScript, downloadPage, downloadScript, cleanPage, translatePage, exportPage, sharedCss, sharedApi] = await Promise.all([
      requestText(origin, '/'),
      requestText(origin, '/app.js'),
      requestText(origin, '/download'),
      requestText(origin, '/download/app.js'),
      requestText(origin, '/clean'),
      requestText(origin, '/translate'),
      requestText(origin, '/export'),
      requestText(origin, '/shared/layout.css'),
      requestText(origin, '/shared/api.js')
    ]);

    assert.equal(shellPage.status, 200);
    assert.match(shellPage.text, /id="app-frame"/);
    assert.equal(shellScript.status, 200);
    assert.match(shellScript.text, /\/download/);

    assert.equal(downloadPage.status, 200);
    assert.match(downloadPage.text, /id="download-form"/);
    assert.equal(downloadScript.status, 200);
    assert.match(downloadScript.text, /normalizeGithubUrls/);

    assert.equal(cleanPage.status, 200);
    assert.match(cleanPage.text, /name="rulesFile"/);

    assert.equal(translatePage.status, 200);
    assert.match(translatePage.text, /name="deepseekApiKey"/);

    assert.equal(exportPage.status, 200);
    assert.match(exportPage.text, /name="appendLicenseNote"/);

    assert.equal(sharedCss.status, 200);
    assert.match(sharedCss.headers['content-type'], /text\/css/);
    assert.match(sharedCss.text, /\.app-shell/);

    assert.equal(sharedApi.status, 200);
    assert.match(sharedApi.headers['content-type'], /application\/javascript/);
    assert.match(sharedApi.text, /export async function getJson/);
  } finally {
    await close();
  }
});

test('gui-server 启动脚本复用 createAppServer 并打开根路径', async () => {
  const script = await readText('scripts/gui-server.mjs');

  assert.match(script, /createAppServer/);
  assert.match(script, /127\.0\.0\.1:3210\/?/);
  assert.doesNotMatch(script, /translationJobs\s*=\s*new Map/);
});

test('start-gui 启动脚本不会把 Playwright 安装当成 GUI 启动前置条件', async () => {
  const script = await readText('start-gui.bat');

  assert.match(script, /api\/config/);
  assert.doesNotMatch(script, /playwright install chromium/i);
});
