import path from 'node:path';
import { stat } from 'node:fs/promises';

import { scanMarkdownFiles } from '../shared/files.mjs';
import { sendJson } from '../shared/http.mjs';

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    error.code = 'INVALID_JSON';
    throw error;
  }
}

export function createFilesRoute({ projectRoot }) {
  return async function handleFilesRoute(request, response, url) {
    if (request.method !== 'POST' || url.pathname !== '/api/files/scan-markdown') {
      return false;
    }

    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      if (error.code === 'INVALID_JSON') {
        sendJson(response, 400, { ok: false, error: 'Invalid JSON body' });
        return true;
      }
      throw error;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(response, 400, { ok: false, error: 'Request body must be a JSON object' });
      return true;
    }

    const topLevelDir = typeof payload.topLevelDir === 'string' ? payload.topLevelDir.trim() : '';

    if (!topLevelDir) {
      sendJson(response, 400, { ok: false, error: 'topLevelDir is required' });
      return true;
    }

    const resolvedTopLevelDir = path.resolve(projectRoot, topLevelDir);

    try {
      const topLevelStat = await stat(resolvedTopLevelDir);
      if (!topLevelStat.isDirectory()) {
        sendJson(response, 400, { ok: false, error: 'topLevelDir must point to a directory' });
        return true;
      }

      const files = await scanMarkdownFiles(resolvedTopLevelDir, resolvedTopLevelDir);
      sendJson(response, 200, {
        ok: true,
        topLevelDir: resolvedTopLevelDir,
        files
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(response, 404, { ok: false, error: 'topLevelDir not found' });
        return true;
      }

      throw error;
    }

    return true;
  };
}
