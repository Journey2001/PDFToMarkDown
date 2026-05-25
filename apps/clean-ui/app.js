import { getJson, postJson } from '../shared/api.js';
import { pollJobUntilSettled } from '../shared/jobs.js';
import { getSelectedMarkdownPaths, scanMarkdownInto } from '../shared/markdown-picker.js';

const EMPTY_JOB_SUMMARY = '尚未提交任务';
const IDLE_LOG_TEXT = '清洗子应用尚未开始执行任务。';

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

function buildRulesUrl(rulesFile) {
  const params = new URLSearchParams({ rulesFile });
  return `/api/clean/rules?${params.toString()}`;
}

function createTextField(doc, { labelText, className, value = '', multiline = false }) {
  const wrapper = doc.createElement('label');
  const label = doc.createElement('span');
  const input = doc.createElement(multiline ? 'textarea' : 'input');

  label.textContent = labelText;
  input.className = className;
  input.value = value;
  if (!multiline) {
    input.type = 'text';
  }

  wrapper.append(label, input);
  return wrapper;
}

export function renderCleanupRules(elements, rules = [], builtInRules = []) {
  if (!elements.rulesList || !elements.builtInRulesList) {
    return;
  }

  elements.currentBuiltInRules = builtInRules;
  const doc = elements.rulesList.ownerDocument;
  elements.rulesList.innerHTML = '';

  if (rules.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'field-hint';
    empty.textContent = '当前规则文件里没有正则规则。';
    elements.rulesList.append(empty);
  }

  for (const [index, rule] of rules.entries()) {
    const card = doc.createElement('details');
    card.className = 'rule-card';
    card.open = index === 0;

    const summary = doc.createElement('summary');
    summary.className = 'rule-card-summary';

    const enabledLabel = doc.createElement('label');
    enabledLabel.className = 'rule-enabled';
    const enabled = doc.createElement('input');
    enabled.className = 'rule-enabled-input';
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled !== false;
    const enabledText = doc.createElement('span');
    enabledText.textContent = '启用';
    enabledLabel.append(enabled, enabledText);

    const summaryTitle = doc.createElement('span');
    summaryTitle.className = 'rule-summary-title';
    summaryTitle.textContent = rule.name || `Rule ${index + 1}`;

    const summaryMeta = doc.createElement('span');
    summaryMeta.className = 'rule-summary-meta';
    summaryMeta.textContent = rule.id || `rule-${index + 1}`;

    summary.append(enabledLabel, summaryTitle, summaryMeta);

    const body = doc.createElement('div');
    body.className = 'rule-card-body';

    const header = doc.createElement('div');
    header.className = 'rule-card-header';

    const id = doc.createElement('input');
    id.className = 'rule-id-input';
    id.type = 'text';
    id.value = rule.id || `rule-${index + 1}`;
    id.placeholder = '规则 ID';

    header.append(id);

    const name = createTextField(doc, {
      labelText: '规则名称',
      className: 'rule-name-input',
      value: rule.name || ''
    });

    const fields = doc.createElement('div');
    fields.className = 'rule-fields';
    fields.append(
      createTextField(doc, {
        labelText: 'pattern',
        className: 'rule-pattern-input',
        value: rule.pattern || '',
        multiline: true
      }),
      createTextField(doc, {
        labelText: 'flags',
        className: 'rule-flags-input',
        value: rule.flags || 'gm'
      })
    );

    const replacement = createTextField(doc, {
      labelText: 'replacement（留空表示删除）',
      className: 'rule-replacement-input replacement-input',
      value: rule.replacement || '',
      multiline: true
    });

    body.append(header, name, fields, replacement);
    card.append(summary, body);
    elements.rulesList.append(card);
  }

  elements.builtInRulesList.innerHTML = '';
  for (const rule of builtInRules) {
    const card = doc.createElement('div');
    card.className = 'built-in-rule-card';
    const title = doc.createElement('strong');
    title.textContent = rule.name || rule.id;
    const description = doc.createElement('p');
    description.className = 'field-hint';
    description.textContent = rule.description || '内置处理';
    card.append(title, description);
    elements.builtInRulesList.append(card);
  }
}

export function collectCleanupRules(elements) {
  if (!elements.rulesList?.querySelectorAll) {
    return [];
  }

  return Array.from(elements.rulesList.querySelectorAll('.rule-card')).map((card, index) => ({
    id: card.querySelector('.rule-id-input')?.value.trim() || `rule-${index + 1}`,
    name: card.querySelector('.rule-name-input')?.value.trim() || `Rule ${index + 1}`,
    pattern: card.querySelector('.rule-pattern-input')?.value || '',
    flags: card.querySelector('.rule-flags-input')?.value.trim() || 'gm',
    replacement: card.querySelector('.rule-replacement-input')?.value || '',
    enabled: card.querySelector('.rule-enabled-input')?.checked !== false
  }));
}

async function loadCleanupRules(elements, options = {}) {
  if (!elements.rulesList || !elements.builtInRulesList) {
    return null;
  }

  const getRules = typeof options.getRules === 'function' ? options.getRules : getJson;
  const rulesFile = elements.rulesFileInput.value.trim() || 'config/cleanup-rules.json';
  const data = await getRules(buildRulesUrl(rulesFile));
  renderCleanupRules(elements, data.rules, data.builtInRules);
  return data;
}

async function saveCleanupRules(elements, options = {}) {
  const saveRules = typeof options.saveRules === 'function'
    ? options.saveRules
    : (payload) => postJson('/api/clean/rules', payload);
  const rulesFile = elements.rulesFileInput.value.trim() || 'config/cleanup-rules.json';
  const rules = collectCleanupRules(elements);

  return saveRules({ rulesFile, rules });
}

export function buildCleanPayload({ markdownPaths, rulesFile, outputPath }) {
  if (!Array.isArray(markdownPaths) || markdownPaths.length === 0) {
    throw new Error('请先扫描并选择至少一个 Markdown 文件。');
  }

  if (!rulesFile) {
    throw new Error('请填写规则文件路径。');
  }

  if (outputPath && markdownPaths.length > 1) {
    throw new Error('多文件批量清洗时不能填写统一输出路径。');
  }

  return {
    markdownPaths,
    rulesFile,
    ...(outputPath ? { outputPath } : {})
  };
}

function collectElements(doc) {
  return {
    scanForm: doc.querySelector('#scan-form'),
    runForm: doc.querySelector('#clean-form'),
    scanRootInput: doc.querySelector('#scan-root'),
    rulesFileInput: doc.querySelector('#rules-file'),
    rulesList: doc.querySelector('#cleanup-rules-list'),
    builtInRulesList: doc.querySelector('#built-in-rules-list'),
    loadRulesButton: doc.querySelector('#load-rules-button'),
    addRuleButton: doc.querySelector('#add-rule-button'),
    saveRulesButton: doc.querySelector('#save-rules-button'),
    outputPathInput: doc.querySelector('#clean-output-path'),
    markdownSelect: doc.querySelector('#markdown-files'),
    scanButton: doc.querySelector('#scan-button'),
    submitButton: doc.querySelector('#submit-clean'),
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
    elements.rulesFileInput.value = 'config/cleanup-rules.json';
    await loadCleanupRules(elements, { getRules: options.getRules });
  } catch (error) {
    elements.jobLogOutput.textContent = `加载默认配置失败：${error.message}`;
  }
}

export function initializeCleanApp(doc = globalThis.document, options = {}) {
  if (!doc?.querySelector) {
    return null;
  }

  const elements = collectElements(doc);
  if (!elements.scanForm || !elements.runForm) {
    return null;
  }

  const createJob = typeof options.createJob === 'function'
    ? options.createJob
    : (payload) => postJson('/api/clean/jobs', payload);
  const pollJob = typeof options.pollJob === 'function'
    ? options.pollJob
    : pollJobUntilSettled;
  const scanMarkdown = typeof options.scanMarkdown === 'function'
    ? options.scanMarkdown
    : scanMarkdownInto;

  clearJobResult(elements);

  elements.loadRulesButton?.addEventListener('click', async () => {
    try {
      const data = await loadCleanupRules(elements, { getRules: options.getRules });
      setStatus(elements, 'success', `已读取 ${data.rules.length} 条正则规则。`);
    } catch (error) {
      setStatus(elements, 'error', error.message);
      elements.jobLogOutput.textContent = error.stack || error.message;
    }
  });

  elements.addRuleButton?.addEventListener('click', () => {
    const rules = collectCleanupRules(elements);
    rules.push({
      id: `custom-rule-${rules.length + 1}`,
      name: '自定义正则规则',
      pattern: '',
      flags: 'gm',
      replacement: '',
      enabled: true
    });
    renderCleanupRules(elements, rules, elements.currentBuiltInRules || []);
  });

  elements.saveRulesButton?.addEventListener('click', async () => {
    try {
      const data = await saveCleanupRules(elements, { saveRules: options.saveRules });
      renderCleanupRules(elements, data.rules, data.builtInRules);
      setStatus(elements, 'success', `已保存 ${data.rules.length} 条正则规则。`);
    } catch (error) {
      setStatus(elements, 'error', error.message);
      elements.jobLogOutput.textContent = error.stack || error.message;
    }
  });

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
    const rulesFile = elements.rulesFileInput.value.trim();
    const outputPath = elements.outputPathInput.value.trim();
    let payload;

    try {
      payload = buildCleanPayload({ markdownPaths, rulesFile, outputPath });
    } catch (error) {
      clearJobResult(elements);
      setStatus(elements, 'error', error.message);
      return;
    }

    elements.submitButton.disabled = true;
    setStatus(elements, 'running', '正在创建清洗任务...');

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
      setStatus(elements, job.status === 'completed' ? 'success' : 'error', job.status === 'completed' ? '清洗任务已完成。' : '清洗任务执行失败。');
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
  initializeCleanApp(document);
}
