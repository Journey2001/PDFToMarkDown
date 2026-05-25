import { getJson, postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';

export const EMPTY_JOB_SUMMARY = '尚未提交任务';
export const IDLE_LOG_TEXT = '下载子应用尚未开始执行任务。';

function setStatus(elements, state, text) {
  elements.jobStatusBadge.className = `status-badge status-${state}`;
  elements.jobStatusBadge.textContent = state;
  elements.statusText.textContent = text;
}

export function normalizeGithubUrls(rawValue = '') {
  return rawValue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatJobSummary(job) {
  if (!Array.isArray(job?.items) || job.items.length === 0) {
    return '任务中没有可显示的条目。';
  }

  return job.items
    .map((item, index) => {
      const outputPath = item.result?.markdownPath || item.error || '处理中';
      return `${index + 1}. [${item.status}] ${item.githubUrl}\n   ${outputPath}`;
    })
    .join('\n');
}

export function clearJobResult(elements, options = {}) {
  elements.jobIdOutput.textContent = '-';
  elements.jobStateOutput.textContent = '-';
  elements.jobCountOutput.textContent = '0';
  elements.jobSummaryOutput.textContent = options.summaryText ?? EMPTY_JOB_SUMMARY;
  elements.jobLogOutput.textContent = options.logMessage ?? IDLE_LOG_TEXT;
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
    form: doc.querySelector('#download-form'),
    githubUrlsInput: doc.querySelector('#github-urls'),
    outputRootInput: doc.querySelector('#output-root'),
    submitButton: doc.querySelector('#submit-download'),
    statusText: doc.querySelector('#status-text'),
    jobStatusBadge: doc.querySelector('#job-status-badge'),
    jobIdOutput: doc.querySelector('#job-id'),
    jobStateOutput: doc.querySelector('#job-state'),
    jobCountOutput: doc.querySelector('#job-count'),
    jobSummaryOutput: doc.querySelector('#job-summary'),
    jobLogOutput: doc.querySelector('#job-log')
  };
}

export async function loadDefaults(elements, options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : getJson;

  try {
    await getConfig('/api/config');
    elements.outputRootInput.value = 'downloads';
    elements.outputRootInput.placeholder = '例如：D:\\Docs\\Markdown，或 downloads';
  } catch (error) {
    elements.jobLogOutput.textContent = `加载默认配置失败：${error.message}`;
  }
}

export function initializeDownloadApp(doc = globalThis.document, options = {}) {
  if (!doc?.querySelector) {
    return null;
  }

  const elements = collectElements(doc);
  if (!elements.form) {
    return null;
  }

  const createJob = typeof options.createJob === 'function'
    ? options.createJob
    : (payload) => postJson('/api/download/jobs', payload);
  const pollJob = typeof options.pollJob === 'function'
    ? options.pollJob
    : pollJobUntilSettled;

  clearJobResult(elements);

  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const githubUrls = normalizeGithubUrls(elements.githubUrlsInput.value);
    const outputRoot = elements.outputRootInput.value.trim();

    if (githubUrls.length === 0) {
      clearJobResult(elements);
      setStatus(elements, 'error', '请至少输入一个 GitHub Markdown URL。');
      return;
    }

    if (!outputRoot) {
      clearJobResult(elements);
      setStatus(elements, 'error', '请填写保存目录。');
      return;
    }

    elements.submitButton.disabled = true;
    setStatus(elements, 'running', '正在创建下载任务...');

    let hasCreatedJob = false;

    try {
      const created = await createJob({ githubUrls, outputRoot });
      hasCreatedJob = true;
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
      setStatus(
        elements,
        job.status === 'completed' ? 'success' : 'error',
        job.status === 'completed' ? '下载任务已完成。' : '下载任务执行失败。'
      );
    } catch (error) {
      if (!hasCreatedJob) {
        clearJobResult(elements, {
          logMessage: error.stack || error.message
        });
      }

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
  initializeDownloadApp(document);
}
