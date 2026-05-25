import { getJson, postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';
import { getSelectedMarkdownPaths, scanMarkdownInto } from '../shared/markdown-picker.js';

const EMPTY_JOB_SUMMARY = '尚未提交任务';
const IDLE_LOG_TEXT = '导出子应用尚未开始执行任务。';

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
    const htmlPath = item.result?.htmlPath || item.error || '处理中';
    const pdfPath = item.result?.pdfPath ? `\n   PDF: ${item.result.pdfPath}` : '';
    return `${index + 1}. [${item.status}] ${item.markdownPath}\n   HTML: ${htmlPath}${pdfPath}`;
  }).join('\n');
}

function renderJob(elements, job) {
  elements.jobIdOutput.textContent = job?.id || '-';
  elements.jobStateOutput.textContent = job?.status || '-';
  elements.jobCountOutput.textContent = Array.isArray(job?.items) ? String(job.items.length) : '0';
  elements.jobSummaryOutput.textContent = formatJobSummary(job);
  elements.jobLogOutput.textContent = JSON.stringify(job, null, 2);
}

function collectElements(doc) {
  return {
    scanForm: doc.querySelector('#scan-form'),
    runForm: doc.querySelector('#export-form'),
    scanRootInput: doc.querySelector('#scan-root'),
    markdownSelect: doc.querySelector('#markdown-files'),
    langInput: doc.querySelector('#lang'),
    watermarkTextInput: doc.querySelector('#watermark-text'),
    appendLicenseNoteInput: doc.querySelector('#append-license-note'),
    licenseNoteInput: doc.querySelector('#license-note'),
    scanButton: doc.querySelector('#scan-button'),
    submitButton: doc.querySelector('#submit-export'),
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

  elements.langInput.value = 'zh-CN';
}

export function initializeExportApp(doc = globalThis.document, options = {}) {
  if (!doc?.querySelector) {
    return null;
  }

  const elements = collectElements(doc);
  if (!elements.scanForm || !elements.runForm) {
    return null;
  }

  const createJob = typeof options.createJob === 'function'
    ? options.createJob
    : (payload) => postJson('/api/export/jobs', payload);
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

  elements.runForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const markdownPaths = getSelectedMarkdownPaths(elements.markdownSelect);
    const lang = elements.langInput.value.trim() || 'zh-CN';

    if (markdownPaths.length === 0) {
      clearJobResult(elements);
      setStatus(elements, 'error', '请先扫描并选择至少一个 Markdown 文件。');
      return;
    }

    elements.submitButton.disabled = true;
    setStatus(elements, 'running', '正在创建导出任务...');

    try {
      const created = await createJob({
        markdownPaths,
        lang,
        watermarkText: elements.watermarkTextInput.value.trim(),
        appendLicenseNote: elements.appendLicenseNoteInput.checked,
        licenseNote: elements.licenseNoteInput.value.trim()
      });

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
      setStatus(elements, job.status === 'completed' ? 'success' : 'error', job.status === 'completed' ? '导出任务已完成。' : '导出任务执行失败。');
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
  initializeExportApp(document);
}
