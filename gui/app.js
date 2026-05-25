const form = document.querySelector('#export-form');
const statusText = document.querySelector('#status-text');
const resultBadge = document.querySelector('#result-badge');
const logOutput = document.querySelector('#log-output');
const fetchMarkdownButton = document.querySelector('#fetch-markdown-button');
const cleanButton = document.querySelector('#clean-button');
const translateButton = document.querySelector('#translate-button');
const submitButton = document.querySelector('#submit-button');
const cleanedLink = document.querySelector('#cleaned-link');
const translatedLink = document.querySelector('#translated-link');
const markdownLink = document.querySelector('#markdown-link');
const htmlLink = document.querySelector('#html-link');
const pdfLink = document.querySelector('#pdf-link');
const imageCount = document.querySelector('#image-count');
const chunkCount = document.querySelector('#chunk-count');
const chunkCompletedCount = document.querySelector('#chunk-completed-count');
const chunkSkippedCount = document.querySelector('#chunk-skipped-count');
const chunkCacheHitCount = document.querySelector('#chunk-cache-hit-count');
const translateConcurrency = document.querySelector('#translate-concurrency');
const translateRetryCount = document.querySelector('#translate-retry-count');
const cleanupCount = document.querySelector('#cleanup-count');
const translateProgressBar = document.querySelector('#translate-progress-bar');
const translateProgressLabel = document.querySelector('#translate-progress-label');
const translateProgressText = document.querySelector('#translate-progress-text');
const githubInput = document.querySelector('#github-url');
const inputPath = document.querySelector('#input-path');
const outputRoot = document.querySelector('#output-root');
const markdownSelect = document.querySelector('#markdown-select');
const refreshFilesButton = document.querySelector('#refresh-files');
const targetLanguage = document.querySelector('#target-language');
const translateModel = document.querySelector('#translate-model');
const translateConcurrencyInput = document.querySelector('#translate-concurrency-input');
const translateBatchSizeInput = document.querySelector('#translate-batch-size-input');
const deepseekApiKey = document.querySelector('#deepseek-api-key');
const translateOutputPath = document.querySelector('#translate-output-path');
const translateCacheFile = document.querySelector('#translate-cache-file');
const clearTranslationCacheButton = document.querySelector('#clear-translation-cache');
const cleanOutputPath = document.querySelector('#clean-output-path');
const cleanupRulesContainer = document.querySelector('#cleanup-rules');
const addRuleButton = document.querySelector('#add-rule');
const saveRulesButton = document.querySelector('#save-rules');

const storageKeys = {
  apiKey: 'pdf-to-markdown.deepseekApiKey',
  model: 'pdf-to-markdown.translateModel',
  concurrency: 'pdf-to-markdown.translateConcurrency',
  batchSize: 'pdf-to-markdown.translateBatchSize',
  cacheFile: 'pdf-to-markdown.translateCacheFile'
};

let cleanupRules = [];
let translateJobPollTimer = null;

function setBadge(state, label) {
  resultBadge.className = `result-badge ${state}`;
  resultBadge.textContent = label;
}

function bindLink(anchor, href, text) {
  anchor.href = href || '#';
  anchor.textContent = text || '尚未生成';
}

function resetLink(anchor) {
  bindLink(anchor, '#', '尚未生成');
}

function setModeState(mode) {
  const githubMode = mode === 'github';
  githubInput.disabled = !githubMode;
  inputPath.disabled = githubMode;
  markdownSelect.disabled = githubMode;
  fetchMarkdownButton.hidden = !githubMode;
  cleanButton.hidden = githubMode;
  translateButton.hidden = githubMode;
  submitButton.hidden = githubMode;
}

function resetTranslateProgress() {
  translateProgressBar.style.width = '0%';
  translateProgressLabel.textContent = '0%';
  translateProgressText.textContent = '尚未开始翻译任务。';
  chunkCount.textContent = '-';
  chunkCompletedCount.textContent = '-';
  chunkSkippedCount.textContent = '-';
  chunkCacheHitCount.textContent = '-';
  translateConcurrency.textContent = '-';
  translateRetryCount.textContent = '-';
}

function updateTranslateProgress(progress = {}) {
  const percent = progress.percent ?? 0;
  translateProgressBar.style.width = `${percent}%`;
  translateProgressLabel.textContent = `${percent}%`;
  chunkCount.textContent = `${progress.totalWorkItems ?? '-'}`;
  chunkCompletedCount.textContent = `${progress.completedWorkItems ?? '-'}`;
  chunkSkippedCount.textContent = `${progress.skippedChunkCount ?? '-'}`;
  chunkCacheHitCount.textContent = `${progress.cacheHitCount ?? '-'}`;
  translateConcurrency.textContent = `${progress.concurrency ?? '-'}`;
  translateRetryCount.textContent = `${progress.retryCount ?? '-'}`;

  if (progress.stage === 'completed') {
    translateProgressText.textContent = `翻译完成，共 ${progress.totalWorkItems ?? 0} 块，跳过 ${progress.skippedChunkCount ?? 0} 块，缓存命中 ${progress.cacheHitCount ?? 0} 块。`;
    return;
  }

  if (progress.stage === 'retry') {
    translateProgressText.textContent = `第 ${progress.workItemIndex ?? 0} 块重试中，当前已重试 ${progress.retryCount ?? 0} 次。`;
    return;
  }

  if (progress.stage === 'start') {
    translateProgressText.textContent = `翻译已启动，共 ${progress.totalWorkItems ?? 0} 块，并发 ${progress.concurrency ?? 0}，缓存命中 ${progress.cacheHitCount ?? 0} 块。`;
    return;
  }

  if (progress.stage === 'progress') {
    translateProgressText.textContent = `已完成 ${progress.completedWorkItems ?? 0}/${progress.totalWorkItems ?? 0} 块，剩余 ${progress.remainingWorkItems ?? 0} 块。`;
  }
}

function stopTranslatePolling() {
  if (!translateJobPollTimer) {
    return;
  }

  window.clearInterval(translateJobPollTimer);
  translateJobPollTimer = null;
}

async function pollTranslateJob(jobId) {
  const response = await fetch(`/api/translate-jobs/${encodeURIComponent(jobId)}`);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || '无法获取翻译任务状态');
  }

  updateTranslateProgress(data.job.progress);
  logOutput.textContent = `翻译任务状态:\n${JSON.stringify(data.job, null, 2)}`;

  if (data.job.status === 'completed') {
    stopTranslatePolling();
    bindLink(translatedLink, data.links.markdown, data.job.result.outputPath);
    inputPath.value = data.job.result.outputPath;
    await loadMarkdownFiles(data.job.result.outputPath);
    statusText.textContent = '翻译完成';
    setBadge('success', 'Success');
    return data.job;
  }

  if (data.job.status === 'failed') {
    stopTranslatePolling();
    statusText.textContent = '翻译失败';
    setBadge('error', 'Error');
    translateProgressText.textContent = data.job.error || '翻译任务失败';
    throw new Error(data.job.error || '翻译任务失败');
  }

  return data.job;
}

async function startTranslatePolling(jobId) {
  stopTranslatePolling();
  await pollTranslateJob(jobId);
  translateJobPollTimer = window.setInterval(() => {
    pollTranslateJob(jobId).catch((error) => {
      stopTranslatePolling();
      statusText.textContent = '翻译失败';
      setBadge('error', 'Error');
      logOutput.textContent = error.message;
    });
  }, 1000);
}

function loadLocalPreference(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function saveLocalPreference(key, value) {
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }

    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures.
  }
}

function applyStoredTranslationPreferences(defaultModel) {
  deepseekApiKey.value = loadLocalPreference(storageKeys.apiKey);
  translateModel.value = loadLocalPreference(storageKeys.model) || defaultModel;
  translateConcurrencyInput.value = loadLocalPreference(storageKeys.concurrency) || '';
  translateBatchSizeInput.value = loadLocalPreference(storageKeys.batchSize) || '';
  translateCacheFile.value = loadLocalPreference(storageKeys.cacheFile) || '';
}

function setLocalMode() {
  const localRadio = document.querySelector('input[name="mode"][value="local"]');
  localRadio.checked = true;
  setModeState('local');
}

function createRule(defaults = {}) {
  return {
    id: defaults.id || `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: defaults.name || '',
    pattern: defaults.pattern || '',
    flags: defaults.flags || 'gm',
    replacement: typeof defaults.replacement === 'string' ? defaults.replacement : '',
    enabled: defaults.enabled !== false
  };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderCleanupRules() {
  if (cleanupRules.length === 0) {
    cleanupRulesContainer.innerHTML = '<p class="rule-empty">暂无规则，点击“添加规则”开始配置。</p>';
    return;
  }

  cleanupRulesContainer.innerHTML = cleanupRules.map((rule, index) => `
    <article class="rule-card" data-rule-id="${escapeHtml(rule.id)}">
      <div class="rule-card-header">
        <strong>规则 ${index + 1}</strong>
        <button class="secondary-button danger-button delete-rule" type="button" data-rule-id="${escapeHtml(rule.id)}">删除</button>
      </div>
      <label class="field">
        <span>规则名称</span>
        <input type="text" data-field="name" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.name)}" placeholder="例如：移除 Source 行" />
      </label>
      <label class="field">
        <span>正则表达式</span>
        <input type="text" data-field="pattern" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.pattern)}" placeholder="例如：\\*\\*Source\\*\\*:\\s.*(?:\\r?\\n)?" />
      </label>
      <div class="field-row rule-field-row">
        <label class="field">
          <span>Flags</span>
          <input type="text" data-field="flags" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.flags)}" placeholder="gm" />
        </label>
        <label class="field">
          <span>替换内容</span>
          <input type="text" data-field="replacement" data-rule-id="${escapeHtml(rule.id)}" value="${escapeHtml(rule.replacement)}" placeholder="留空表示删除" />
        </label>
      </div>
      <label class="toggle-item rule-toggle">
        <input type="checkbox" data-field="enabled" data-rule-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''} />
        <span>启用此规则</span>
      </label>
    </article>
  `).join('');
}

async function loadCleanupRules() {
  const response = await fetch('/api/cleanup-rules');
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || '无法加载清理规则');
  }

  cleanupRules = data.rules.map((rule) => createRule(rule));
  renderCleanupRules();
}

function collectCleanupRulesFromDom() {
  cleanupRules = cleanupRules.map((rule) => ({
    ...rule,
    name: document.querySelector(`[data-field="name"][data-rule-id="${rule.id}"]`)?.value?.trim() || '',
    pattern: document.querySelector(`[data-field="pattern"][data-rule-id="${rule.id}"]`)?.value || '',
    flags: document.querySelector(`[data-field="flags"][data-rule-id="${rule.id}"]`)?.value?.trim() || 'gm',
    replacement: document.querySelector(`[data-field="replacement"][data-rule-id="${rule.id}"]`)?.value || '',
    enabled: Boolean(document.querySelector(`[data-field="enabled"][data-rule-id="${rule.id}"]`)?.checked)
  }));

  return cleanupRules;
}

async function saveCleanupRules() {
  const rules = collectCleanupRulesFromDom();
  const response = await fetch('/api/cleanup-rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules })
  });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || '保存清理规则失败');
  }

  cleanupRules = data.rules.map((rule) => createRule(rule));
  renderCleanupRules();
  return data;
}

async function loadMarkdownFiles(selectedPath = '') {
  const response = await fetch('/api/markdown-files');
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || '无法加载 Markdown 列表');
  }

  const currentValue = selectedPath || markdownSelect.value || inputPath.value;
  markdownSelect.innerHTML = '<option value="">请选择一个 Markdown 文档</option>';

  data.files.forEach((file) => {
    const option = document.createElement('option');
    option.value = file.path;
    option.textContent = file.relativePath;
    if (file.path === currentValue) {
      option.selected = true;
    }
    markdownSelect.append(option);
  });
}

async function loadDefaults() {
  const response = await fetch('/api/config');
  const config = await response.json();
  outputRoot.value = config.outputRoot;
  inputPath.value = config.sampleInputPath;
  githubInput.value = 'https://github.com/ZeroLu/awesome-gpt-image/blob/main/README.zh-CN.md';
  targetLanguage.value = config.defaultTranslationTarget;
  applyStoredTranslationPreferences(config.defaultTranslationModel);
  if (!translateConcurrencyInput.value) {
    translateConcurrencyInput.value = `${config.defaultTranslationConcurrency ?? 12}`;
  }
  if (!translateBatchSizeInput.value) {
    translateBatchSizeInput.value = `${config.defaultTranslationBatchSize ?? 1}`;
  }
  if (!translateCacheFile.value) {
    translateCacheFile.value = config.defaultTranslationCacheFile || '';
  }
  setModeState('github');
  await loadMarkdownFiles(config.sampleInputPath);
  await loadCleanupRules();
  resetTranslateProgress();
}

async function clearTranslationCache() {
  const payload = {
    inputPath: inputPath.value.trim(),
    cacheFile: translateCacheFile.value.trim()
  };

  const response = await fetch('/api/clear-translation-cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || '清理翻译缓存失败');
  }

  return data;
}

translateModel.addEventListener('input', () => {
  saveLocalPreference(storageKeys.model, translateModel.value.trim());
});

translateConcurrencyInput.addEventListener('input', () => {
  saveLocalPreference(storageKeys.concurrency, translateConcurrencyInput.value.trim());
});

translateBatchSizeInput.addEventListener('input', () => {
  saveLocalPreference(storageKeys.batchSize, translateBatchSizeInput.value.trim());
});

deepseekApiKey.addEventListener('input', () => {
  saveLocalPreference(storageKeys.apiKey, deepseekApiKey.value.trim());
});

translateCacheFile.addEventListener('input', () => {
  saveLocalPreference(storageKeys.cacheFile, translateCacheFile.value.trim());
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => setModeState(radio.value));
});

markdownSelect.addEventListener('change', () => {
  if (!markdownSelect.value) {
    return;
  }

  inputPath.value = markdownSelect.value;
  setLocalMode();
});

refreshFilesButton.addEventListener('click', async () => {
  try {
    statusText.textContent = '正在刷新 Markdown 列表...';
    await loadMarkdownFiles();
    statusText.textContent = 'Markdown 列表已刷新';
  } catch (error) {
    statusText.textContent = '刷新 Markdown 列表失败';
    setBadge('error', 'Error');
    logOutput.textContent = error.message;
  }
});

addRuleButton.addEventListener('click', () => {
  cleanupRules.push(createRule());
  renderCleanupRules();
});

saveRulesButton.addEventListener('click', async () => {
  try {
    statusText.textContent = '正在保存规则...';
    setBadge('running', 'Running');
    const data = await saveCleanupRules();
    statusText.textContent = '规则已保存';
    setBadge('success', 'Success');
    logOutput.textContent = `规则已保存:\n${JSON.stringify(data.rules, null, 2)}`;
  } catch (error) {
    statusText.textContent = '保存规则失败';
    setBadge('error', 'Error');
    logOutput.textContent = error.message;
  }
});

clearTranslationCacheButton.addEventListener('click', async () => {
  try {
    statusText.textContent = '正在清理翻译缓存...';
    setBadge('running', 'Running');
    const data = await clearTranslationCache();
    chunkCacheHitCount.textContent = '-';
    translateProgressText.textContent = '翻译缓存已清理。';
    statusText.textContent = '翻译缓存已清理';
    setBadge('success', 'Success');
    logOutput.textContent = `缓存清理完成:\n${JSON.stringify(data, null, 2)}`;
  } catch (error) {
    statusText.textContent = '清理翻译缓存失败';
    setBadge('error', 'Error');
    logOutput.textContent = error.message;
  }
});

cleanupRulesContainer.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('.delete-rule');
  if (!deleteButton) {
    return;
  }

  const { ruleId } = deleteButton.dataset;
  cleanupRules = cleanupRules.filter((rule) => rule.id !== ruleId);
  renderCleanupRules();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const mode = formData.get('mode');
  const action = event.submitter?.value || 'export';
  const exportPayload = {
    mode,
    githubUrl: formData.get('githubUrl')?.toString().trim(),
    inputPath: formData.get('inputPath')?.toString().trim(),
    outputRoot: formData.get('outputRoot')?.toString().trim(),
    lang: formData.get('lang')?.toString().trim(),
    stripSources: document.querySelector('#strip-sources').checked,
    appendLicenseNote: document.querySelector('#append-license-note').checked
  };

  const translatePayload = {
    inputPath: formData.get('inputPath')?.toString().trim(),
    outputPath: formData.get('translateOutputPath')?.toString().trim(),
    targetLanguage: formData.get('targetLanguage')?.toString().trim(),
    apiKey: formData.get('deepseekApiKey')?.toString().trim(),
    model: formData.get('translateModel')?.toString().trim(),
    concurrency: Number(formData.get('translateConcurrency')?.toString().trim()) || undefined,
    batchSize: Number(formData.get('translateBatchSize')?.toString().trim()) || undefined,
    cacheFile: formData.get('translateCacheFile')?.toString().trim()
  };

  const cleanPayload = {
    inputPath: formData.get('inputPath')?.toString().trim(),
    outputPath: formData.get('cleanOutputPath')?.toString().trim(),
    rules: collectCleanupRulesFromDom()
  };

  saveLocalPreference(storageKeys.model, translatePayload.model);
  saveLocalPreference(storageKeys.apiKey, translatePayload.apiKey);
  saveLocalPreference(storageKeys.concurrency, translateConcurrencyInput.value.trim());
  saveLocalPreference(storageKeys.batchSize, translateBatchSizeInput.value.trim());
  saveLocalPreference(storageKeys.cacheFile, translateCacheFile.value.trim());

  if (action === 'fetch-markdown' && !exportPayload.githubUrl) {
    statusText.textContent = '抓取失败';
    setBadge('error', 'Error');
    logOutput.textContent = '请先输入一个公开的 GitHub Markdown 地址。';
    return;
  }

  if ((action === 'translate' || action === 'clean' || action === 'export') && !formData.get('inputPath')?.toString().trim()) {
    statusText.textContent = action === 'clean' ? '清理失败' : action === 'translate' ? '翻译失败' : '导出失败';
    setBadge('error', 'Error');
    logOutput.textContent = action === 'clean'
      ? '请先选择一个本地 Markdown 文档再清理。'
      : action === 'translate'
        ? '请先选择一个本地 Markdown 文档再翻译。'
        : '请先选择一个本地 Markdown 文档再导出。';
    return;
  }

  statusText.textContent = action === 'fetch-markdown'
    ? '正在抓取并生成本地 Markdown，请稍候...'
    : action === 'translate'
      ? '正在翻译，请稍候...'
      : action === 'clean'
        ? '正在清理，请稍候...'
        : '正在导出，请稍候...';
  setBadge('running', 'Running');
  logOutput.textContent = `请求参数:\n${JSON.stringify(
    action === 'fetch-markdown'
      ? exportPayload
      : action === 'translate'
        ? { ...translatePayload, apiKey: translatePayload.apiKey ? '***' : '' }
        : action === 'clean'
          ? { ...cleanPayload, rules: cleanPayload.rules }
          : exportPayload,
    null,
    2
  )}`;

  try {
    const endpoint = action === 'fetch-markdown'
      ? '/api/fetch-markdown'
      : action === 'translate'
        ? '/api/translate'
        : action === 'clean'
          ? '/api/clean-markdown'
          : '/api/export';
    const payload = action === 'fetch-markdown'
      ? exportPayload
      : action === 'translate'
        ? translatePayload
        : action === 'clean'
          ? cleanPayload
          : exportPayload;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || (
        action === 'fetch-markdown'
          ? '抓取失败'
          : action === 'translate'
            ? '翻译失败'
            : action === 'clean'
              ? '清理失败'
              : '导出失败'
      ));
    }

    if (action === 'fetch-markdown') {
      bindLink(markdownLink, data.links.markdown, data.result.markdownPath);
      imageCount.textContent = `${data.result.imageCount ?? '-'}`;
      cleanupCount.textContent = '-';
      chunkCount.textContent = '-';
      statusText.textContent = '已生成本地 Markdown';
    } else if (action === 'translate') {
      resetTranslateProgress();
      translateProgressText.textContent = '翻译任务已创建，正在获取进度...';
      imageCount.textContent = '-';
      cleanupCount.textContent = '-';
      await startTranslatePolling(data.jobId);
    } else if (action === 'clean') {
      bindLink(cleanedLink, data.links.markdown, data.result.outputPath);
      inputPath.value = data.result.outputPath;
      await loadMarkdownFiles(data.result.outputPath);
      const totalMatches = (data.result.stats || []).reduce((sum, item) => sum + (item.matchCount || 0), 0);
      cleanupCount.textContent = `${totalMatches}`;
      imageCount.textContent = '-';
      chunkCount.textContent = '-';
      statusText.textContent = '清理完成';
    } else {
      bindLink(markdownLink, data.links.markdown, data.result.markdownPath);
      bindLink(htmlLink, data.links.html, data.result.htmlPath);
      bindLink(pdfLink, data.links.pdf, data.result.pdfPath);
      imageCount.textContent = `${data.result.imageCount}`;
      cleanupCount.textContent = '-';
      chunkCount.textContent = '-';
      statusText.textContent = '导出完成';
    }

    setBadge('success', 'Success');
    logOutput.textContent = `${action === 'fetch-markdown' ? '抓取成功' : action === 'translate' ? '翻译成功' : action === 'clean' ? '清理成功' : '导出成功'}:\n${JSON.stringify(data.result, null, 2)}`;
  } catch (error) {
    statusText.textContent = action === 'fetch-markdown' ? '抓取失败' : action === 'translate' ? '翻译失败' : action === 'clean' ? '清理失败' : '导出失败';
    setBadge('error', 'Error');
    logOutput.textContent = error.message;
  }
});

loadDefaults().catch((error) => {
  resetLink(cleanedLink);
  resetLink(translatedLink);
  resetLink(markdownLink);
  resetLink(htmlLink);
  resetLink(pdfLink);
  resetTranslateProgress();
  logOutput.textContent = `初始化失败: ${error.message}`;
  setBadge('error', 'Error');
});
