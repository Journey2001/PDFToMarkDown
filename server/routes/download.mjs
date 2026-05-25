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

function requireStringArray(values, fieldName) {
  if (!Array.isArray(values) || values.length === 0) {
    throw createHttpError(400, `${fieldName} must be a non-empty array`);
  }

  const normalized = values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);

  if (normalized.length !== values.length) {
    throw createHttpError(400, `${fieldName} must only contain non-empty strings`);
  }

  return normalized;
}

function requireOutputRoot(value, projectRoot) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw createHttpError(400, 'outputRoot is required');
  }

  return path.resolve(projectRoot, trimmed);
}

async function runDownloadJob(jobStore, job, service, options) {
  for (const item of job.items) {
    jobStore.updateJobItem(job.id, item.id, { status: 'running' });

    try {
      const result = await service.run({
        githubUrl: item.githubUrl,
        lang: options.lang,
        outputRoot: options.outputRoot,
        stripSources: options.stripSources
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

export function createDownloadRoute({ jobStore, projectRoot, service }) {
  return async function handleDownloadRoute(request, response, url) {
    if (request.method !== 'POST' || url.pathname !== '/api/download/jobs') {
      return false;
    }

    try {
      const payload = await readJsonBody(request);
      requireObject(payload);

      const githubUrls = requireStringArray(payload.githubUrls, 'githubUrls');
      const outputRoot = requireOutputRoot(payload.outputRoot, projectRoot);
      const job = jobStore.createJob({
        type: 'download',
        status: 'running',
        payload: {
          outputRoot,
          stripSources: payload.stripSources === true,
          lang: typeof payload.lang === 'string' ? payload.lang.trim() : undefined
        },
        items: githubUrls.map((githubUrl) => ({
          githubUrl,
          status: 'pending'
        }))
      });

      queueMicrotask(() => {
        void runDownloadJob(jobStore, job, service, {
          lang: job.payload.lang,
          outputRoot,
          stripSources: job.payload.stripSources
        });
      });

      sendJson(response, 200, { ok: true, job });
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { ok: false, error: error.message });
    }

    return true;
  };
}
