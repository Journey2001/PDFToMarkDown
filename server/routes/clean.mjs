import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { sendJson } from '../shared/http.mjs';

const BUILT_IN_RULES = [
  {
    id: 'case-heading-renumber',
    name: '重新编号 Case / 案例标题',
    description: '按正文中出现顺序重新编号 Case / 案例标题，并跳过 fenced code block。该处理需要计数状态，不能可靠地简化为单条正则。'
  }
];

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    error.statusCode = 400;
    error.message = 'Invalid JSON body';
    throw error;
  }
}

function requireObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError(400, 'Request body must be a JSON object');
  }
}

function resolveLocalPath(projectRoot, candidatePath, fieldName) {
  const trimmed = typeof candidatePath === 'string' ? candidatePath.trim() : '';
  if (!trimmed) {
    throw createHttpError(400, `${fieldName} is required`);
  }

  return path.resolve(projectRoot, trimmed);
}

function resolveMarkdownPaths(projectRoot, markdownPaths) {
  if (!Array.isArray(markdownPaths) || markdownPaths.length === 0) {
    throw createHttpError(400, 'markdownPaths must be a non-empty array');
  }

  return markdownPaths.map((markdownPath) => resolveLocalPath(projectRoot, markdownPath, 'markdownPath'));
}

function resolveOptionalProjectPath(projectRoot, candidatePath, fieldName) {
  if (candidatePath === undefined || candidatePath === null) {
    return undefined;
  }

  const trimmed = typeof candidatePath === 'string' ? candidatePath.trim() : '';
  if (!trimmed) {
    throw createHttpError(400, `${fieldName} must be a non-empty string`);
  }

  return resolveLocalPath(projectRoot, trimmed, fieldName);
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw createHttpError(400, `rules[${index}] must be an object`);
  }

  const pattern = typeof rule.pattern === 'string' ? rule.pattern : '';
  if (!pattern) {
    throw createHttpError(400, `rules[${index}].pattern is required`);
  }

  const flags = typeof rule.flags === 'string' && rule.flags.trim() ? rule.flags.trim() : 'gm';

  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw createHttpError(400, `rules[${index}] has invalid regex: ${error.message}`);
  }

  return {
    id: typeof rule.id === 'string' && rule.id.trim() ? rule.id.trim() : `rule-${index + 1}`,
    name: typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : `Rule ${index + 1}`,
    pattern,
    flags,
    replacement: typeof rule.replacement === 'string' ? rule.replacement : '',
    enabled: rule.enabled !== false
  };
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) {
    throw createHttpError(400, 'rules must be an array');
  }

  return rules.map((rule, index) => normalizeRule(rule, index));
}

async function readRulesFile(rulesFile) {
  const rawText = await readFile(rulesFile, 'utf8');
  return normalizeRules(JSON.parse(rawText));
}

async function runCleanJob(jobStore, job, service, options) {
  for (const item of job.items) {
    jobStore.updateJobItem(job.id, item.id, { status: 'running' });

    try {
      const result = await service.run({
        cwd: options.cwd,
        markdownPath: item.markdownPath,
        outputPath: options.outputPath,
        rulesFile: options.rulesFile
      });

      jobStore.updateJobItem(job.id, item.id, {
        status: 'completed',
        result
      });
    } catch (error) {
      jobStore.updateJobItem(job.id, item.id, {
        status: 'failed',
        error: error.message
      });
    }
  }
}

export function createCleanRoute({ jobStore, projectRoot: rootDir, service }) {
  return async function handleCleanRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/clean/')) {
      return false;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/clean/rules') {
        const rulesFile = resolveLocalPath(
          rootDir,
          url.searchParams.get('rulesFile') || 'config/cleanup-rules.json',
          'rulesFile'
        );
        const rules = await readRulesFile(rulesFile);
        sendJson(response, 200, { ok: true, rulesFile, rules, builtInRules: BUILT_IN_RULES });
        return true;
      }

      const payload = await readJsonBody(request);
      requireObject(payload);

      if (request.method === 'POST' && url.pathname === '/api/clean/rules') {
        const rulesFile = resolveLocalPath(rootDir, payload.rulesFile, 'rulesFile');
        const rules = normalizeRules(payload.rules);

        await mkdir(path.dirname(rulesFile), { recursive: true });
        await writeFile(rulesFile, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
        sendJson(response, 200, { ok: true, rulesFile, rules, builtInRules: BUILT_IN_RULES });
        return true;
      }

      if (request.method !== 'POST' || url.pathname !== '/api/clean/jobs') {
        return false;
      }

      const markdownPaths = resolveMarkdownPaths(rootDir, payload.markdownPaths);
      const rulesFile = resolveLocalPath(rootDir, payload.rulesFile, 'rulesFile');
      const outputPath = resolveOptionalProjectPath(rootDir, payload.outputPath, 'outputPath');

      if (outputPath && markdownPaths.length > 1) {
        throw createHttpError(400, 'outputPath cannot be shared by multiple markdownPaths');
      }

      const job = jobStore.createJob({
        type: 'clean',
        status: 'running',
        payload: {
          rulesFile,
          outputPath
        },
        items: markdownPaths.map((markdownPath) => ({
          markdownPath,
          status: 'pending'
        }))
      });

      queueMicrotask(() => {
        void runCleanJob(jobStore, job, service, {
          cwd: rootDir,
          outputPath,
          rulesFile
        });
      });

      sendJson(response, 200, { ok: true, job });
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { ok: false, error: error.message });
    }

    return true;
  };
}
