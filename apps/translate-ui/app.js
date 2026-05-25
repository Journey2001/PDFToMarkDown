import { getJson, postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';
import { getSelectedMarkdownPaths, scanMarkdownInto } from '../shared/markdown-picker.js';

const EMPTY_JOB_SUMMARY = '尚未提交任务';
const IDLE_LOG_TEXT = '翻译子应用尚未开始执行任务。';
const STORAGE_KEYS = {
  model: 'pdf-to-markdown.translate.model',
  concurrency: 'pdf-to-markdown.translate.concurrency',
  batchSize: 'pdf-to-markdown.translate.batchSize',
  cacheFile: 'pdf-to-markdown.translate.cacheFile',
  targetLanguage: 'pdf-to-markdown.translate.targetLanguage'
};

function setStatus(elements, state, text) {
  elements.jobStatusBadge.className = `status-badge status-${state}`;
  elements.jobStatusBadge.textContent = state;
  elements.statusText.textContent = text;
}

function clearJobResult(elements, options = {}) {
  elements.jobIdOutput.textContent = '-';
  elements.jobStateOutput.textContent = '-';
  elements.jobCountOutput.textContent = '0';
  elements.jobSummaryOutput.textContent = options.summaryText ?? EMPTY_JOB_SUMMARY;
  elements.jobLogOutput.textContent = options.logMessage ?? IDLE_LOG_TEXT;
}

function formatJobSummary(job) {
  if (!Array.isArray(job?.items) || job.items.length === 0) {
    return EMPTY_JOB_SUMMARY;
  }

  return job.items.map((item, index) => {
    const outputPath = item.result?.outputPath || item.error || '处理中';
    return `${index + 1}. [${item.status}] ${item.markdownPath}\n   ${outputPath}`;
  }).join('\n');
}

function renderJob(elements, job) {
  elements.jobIdOutput.textContent = job?.id || '-';
  elements.jobStateOutput.textContent = job?.status || '-';
  elements.jobCountOutput.textContent = Array.isArray(job?.items) ? String(job.items.length) : '0';
  elements.jobSummaryOutput.textContent = formatJobSummary(job);
  elements.jobLogOutput.textContent = JSON.stringify(job, null, 2);
}

export function buildTranslatePayload({
  markdownPaths,
  apiKey,
  outputPath,
  cacheFile,
  targetLanguage,
  model,
  concurrency,
  batchSize
}) {
  if (!Array.isArray(markdownPaths) || markdownPaths.length === 0) {
    throw new Error('请先扫描并选择至少一个 Markdown 文件。');
  }

  if (!apiKey) {
    throw new Error('请填写 DeepSeek API Key。');
  }

  if (outputPath && markdownPaths.length > 1) {
    throw new Error('多文件批量翻译时不能填写统一输出路径。');
  }

  const payload = {
    markdownPaths,
    apiKey,
    targetLanguage: targetLanguage || 'zh-CN'
  };

  if (model) {
    payload.model = model;
  }
  if (concurrency) {
    payload.concurrency = concurrency;
  }
  if (batchSize) {
    payload.batchSize = batchSize;
  }
  if (outputPath) {
    payload.outputPath = outputPath;
  }
  if (cacheFile) {
    payload.cacheFile = cacheFile;
  }

  return payload;
}

function loadPreference(key) {
  try {
    return globalThis.localStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function savePreference(key, value) {
  try {
    if (!value) {
      globalThis.localStorage?.removeItem(key);
      return;
    }
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures.
  }
}

function collectElements(doc) {
  return {
    scanForm: doc.querySelector('#scan-form'),
    runForm: doc.querySelector('#translate-form'),
    scanRootInput: doc.querySelector('#scan-root'),
    markdownSelect: doc.querySelector('#markdown-files'),
    targetLanguageInput: doc.querySelector('#target-language'),
    translateModelInput: doc.querySelector('#translate-model'),
    translateConcurrencyInput: doc.querySelector('#translate-concurrency'),
    translateBatchSizeInput: doc.querySelector('#translate-batch-size'),
    apiKeyInput: doc.querySelector('#deepseek-api-key'),
    outputPathInput: doc.querySelector('#translate-output-path'),
    cacheFileInput: doc.querySelector('#translate-cache-file'),
    scanButton: doc.querySelector('#scan-button'),
    submitButton: doc.querySelector('#submit-translate'),
    statusText: doc.querySelector('#status-text'),
    jobStatusBadge: doc.querySelector('#job-status-badge'),
    jobIdOutput: doc.querySelector('#job-id'),
    jobStateOutput: doc.querySelector('#job-state'),
    jobCountOutput: doc.querySelector('#job-count'),
    jobSummaryOutput: doc.querySelector('#job-summary'),
    jobLogOutput: doc.querySelector('#job-log')
  };
}

async function loadDefaults(elements, options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : getJson;

  try {
    await getConfig('/api/config');
    elements.scanRootInput.placeholder = '例如：D:\\Docs\\Markdown，或 output';
  } catch (error) {
    elements.jobLogOutput.textContent = `加载默认配置失败：${error.message}`;
  }

  elements.targetLanguageInput.value = loadPreference(STORAGE_KEYS.targetLanguage) || 'zh-CN';
  elements.translateModelInput.value = loadPreference(STORAGE_KEYS.model) || 'deepseek-chat';
  elements.translateConcurrencyInput.value = loadPreference(STORAGE_KEYS.concurrency) || '';
  elements.translateBatchSizeInput.value = loadPreference(STORAGE_KEYS.batchSize) || '';
  elements.cacheFileInput.value = loadPreference(STORAGE_KEYS.cacheFile) || '';
}

export function initializeTranslateApp(doc = globalThis.document, options = {}) {
  if (!doc?.querySelector) {
    return null;
  }

  const elements = collectElements(doc);
  if (!elements.scanForm || !elements.runForm) {
    return null;
  }

  const createJob = typeof options.createJob === 'function'
    ? options.createJob
    : (payload) => postJson('/api/translate/jobs', payload);
  const pollJob = typeof options.pollJob === 'function'
    ? options.pollJob
    : pollJobUntilSettled;
  const scanMarkdown = typeof options.scanMarkdown === 'function'
    ? options.scanMarkdown
    : scanMarkdownInto;

  clearJobResult(elements);

  elements.scanForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const scanRoot = elements.scanRootInput.value.trim();

    if (!scanRoot) {
      setStatus(elements, 'error', '请先填写顶层目录。');
      return;
    }

    elements.scanButton.disabled = true;
    setStatus(elements, 'running', '正在扫描 Markdown 文件...');

    try {
      const files = await scanMarkdown(elements.markdownSelect, scanRoot);
      setStatus(elements, 'success', `扫描完成，找到 ${files.length} 个 Markdown 文件。`);
      elements.jobLogOutput.textContent = JSON.stringify({ scanRoot, files }, null, 2);
    } catch (error) {
      setStatus(elements, 'error', error.message);
      elements.jobLogOutput.textContent = error.stack || error.message;
    } finally {
      elements.scanButton.disabled = false;
    }
  });

  for (const [key, input] of [
    [STORAGE_KEYS.targetLanguage, elements.targetLanguageInput],
    [STORAGE_KEYS.model, elements.translateModelInput],
    [STORAGE_KEYS.concurrency, elements.translateConcurrencyInput],
    [STORAGE_KEYS.batchSize, elements.translateBatchSizeInput],
    [STORAGE_KEYS.cacheFile, elements.cacheFileInput]
  ]) {
    input.addEventListener('input', () => {
      savePreference(key, input.value.trim());
    });
  }

  elements.runForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const markdownPaths = getSelectedMarkdownPaths(elements.markdownSelect);
    const apiKey = elements.apiKeyInput.value.trim();
    const outputPath = elements.outputPathInput.value.trim();
    const cacheFile = elements.cacheFileInput.value.trim();
    const targetLanguage = elements.targetLanguageInput.value.trim() || 'zh-CN';
    const model = elements.translateModelInput.value.trim();
    const concurrency = Number(elements.translateConcurrencyInput.value.trim()) || undefined;
    const batchSize = Number(elements.translateBatchSizeInput.value.trim()) || undefined;
    let payload;

    try {
      payload = buildTranslatePayload({
        markdownPaths,
        apiKey,
        outputPath,
        cacheFile,
        targetLanguage,
        model,
        concurrency,
        batchSize
      });
    } catch (error) {
      clearJobResult(elements);
      setStatus(elements, 'error', error.message);
      return;
    }

    elements.submitButton.disabled = true;
    setStatus(elements, 'running', '正在创建翻译任务...');

    try {
      const created = await createJob(payload);
      renderJob(elements, created.job);
      setStatus(elements, 'running', '任务已创建，正在轮询状态...');

      const job = await pollJob(created.job.id, {
        intervalMs: 1000,
        timeoutMs: 120000,
        requestTimeoutMs: 5000,
        onUpdate(updatedJob) {
          renderJob(elements, updatedJob);
        }
      });

      renderJob(elements, job);
      setStatus(elements, job.status === 'completed' ? 'success' : 'error', job.status === 'completed' ? '翻译任务已完成。' : '翻译任务执行失败。');
    } catch (error) {
      setStatus(elements, 'error', error.message);
      elements.jobLogOutput.textContent = error.stack || error.message;
    } finally {
      elements.submitButton.disabled = false;
    }
  });

  void loadDefaults(elements, { getConfig: options.getConfig });
  return { elements };
}

if (typeof document !== 'undefined') {
  initializeTranslateApp(document);
}
