import path from 'node:path';

import { sendJson } from '../shared/http.mjs';

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

function requireApiKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw createHttpError(400, 'apiKey is required');
  }

  return trimmed;
}

async function runTranslateJob(jobStore, job, service, options) {
  for (const item of job.items) {
    jobStore.updateJobItem(job.id, item.id, { status: 'running' });

    try {
      const result = await service.run({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        batchSize: options.batchSize,
        cacheFile: options.cacheFile,
        concurrency: options.concurrency,
        markdownPath: item.markdownPath,
        maxChars: options.maxChars,
        model: options.model,
        outputPath: options.outputPath,
        progress: options.progress,
        targetLanguage: options.targetLanguage
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

export function createTranslateRoute({ jobStore, projectRoot, service }) {
  return async function handleTranslateRoute(request, response, url) {
    if (request.method !== 'POST' || url.pathname !== '/api/translate/jobs') {
      return false;
    }

    try {
      const payload = await readJsonBody(request);
      requireObject(payload);

      const markdownPaths = resolveMarkdownPaths(projectRoot, payload.markdownPaths);
      const apiKey = requireApiKey(payload.apiKey);
      const outputPath = resolveOptionalProjectPath(projectRoot, payload.outputPath, 'outputPath');
      const cacheFile = resolveOptionalProjectPath(projectRoot, payload.cacheFile, 'cacheFile');

      if (outputPath && markdownPaths.length > 1) {
        throw createHttpError(400, 'outputPath cannot be shared by multiple markdownPaths');
      }

      const runOptions = {
        apiKey,
        baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : undefined,
        batchSize: payload.batchSize,
        cacheFile,
        concurrency: payload.concurrency,
        maxChars: payload.maxChars,
        model: typeof payload.model === 'string' ? payload.model.trim() : undefined,
        outputPath,
        progress: payload.progress === true,
        targetLanguage: typeof payload.targetLanguage === 'string' ? payload.targetLanguage.trim() : 'zh-CN'
      };
      const job = jobStore.createJob({
        type: 'translate',
        status: 'running',
        payload: {
          baseUrl: runOptions.baseUrl,
          batchSize: runOptions.batchSize,
          cacheFile: runOptions.cacheFile,
          concurrency: runOptions.concurrency,
          maxChars: runOptions.maxChars,
          model: runOptions.model,
          outputPath: runOptions.outputPath,
          progress: runOptions.progress,
          targetLanguage: runOptions.targetLanguage
        },
        items: markdownPaths.map((markdownPath) => ({
          markdownPath,
          status: 'pending'
        }))
      });

      queueMicrotask(() => {
        void runTranslateJob(jobStore, job, service, runOptions);
      });

      sendJson(response, 200, { ok: true, job });
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { ok: false, error: error.message });
    }

    return true;
  };
}
