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

async function runExportJob(jobStore, job, service, options) {
  for (const item of job.items) {
    jobStore.updateJobItem(job.id, item.id, { status: 'running' });

    try {
      const result = await service.run({
        appendLicenseNote: options.appendLicenseNote,
        lang: options.lang,
        licenseNote: options.licenseNote,
        markdownPath: item.markdownPath,
        watermarkText: options.watermarkText
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

export function createExportRoute({ jobStore, projectRoot, service }) {
  return async function handleExportRoute(request, response, url) {
    if (request.method !== 'POST' || url.pathname !== '/api/export/jobs') {
      return false;
    }

    try {
      const payload = await readJsonBody(request);
      requireObject(payload);

      const markdownPaths = resolveMarkdownPaths(projectRoot, payload.markdownPaths);
      const job = jobStore.createJob({
        type: 'export',
        status: 'running',
        payload: {
          appendLicenseNote: payload.appendLicenseNote === true,
          lang: typeof payload.lang === 'string' ? payload.lang.trim() : undefined,
          licenseNote: typeof payload.licenseNote === 'string' ? payload.licenseNote.trim() : '',
          watermarkText: typeof payload.watermarkText === 'string' ? payload.watermarkText.trim() : '',
        },
        items: markdownPaths.map((markdownPath) => ({
          markdownPath,
          status: 'pending'
        }))
      });

      queueMicrotask(() => {
        void runExportJob(jobStore, job, service, job.payload);
      });

      sendJson(response, 200, { ok: true, job });
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { ok: false, error: error.message });
    }

    return true;
  };
}
