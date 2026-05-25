import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { createCleanRoute } from './routes/clean.mjs';
import { createFilesRoute } from './routes/files.mjs';
import { createDownloadRoute } from './routes/download.mjs';
import { createExportRoute } from './routes/export.mjs';
import { createJobsRoute } from './routes/jobs.mjs';
import { createConfigRoute } from './routes/config.mjs';
import { createTranslateRoute } from './routes/translate.mjs';
import { createCleanService } from './services/clean-service.mjs';
import { createDownloadService } from './services/download-service.mjs';
import { createExportService } from './services/export-service.mjs';
import { createTranslateService } from './services/translate-service.mjs';
import { isPathInsideRoot } from './shared/files.mjs';
import { createJobStore } from './shared/job-store.mjs';
import { sendJson } from './shared/http.mjs';

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function deriveJobStatus(job) {
  if (!Array.isArray(job?.items) || job.items.length === 0) {
    return job?.status ?? 'queued';
  }

  const itemStatuses = job.items.map((item) => item.status);

  if (itemStatuses.includes('failed')) {
    return 'failed';
  }

  if (itemStatuses.every((status) => status === 'completed')) {
    return 'completed';
  }

  if (itemStatuses.some((status) => status === 'running' || status === 'completed') || job.status === 'running') {
    return 'running';
  }

  return job.status ?? 'queued';
}

function withDerivedJobStatus(jobStore) {
  return {
    ...jobStore,
    createJob(input = {}) {
      const job = jobStore.createJob(input);
      return {
        ...job,
        status: deriveJobStatus(job)
      };
    },
    getJob(jobId) {
      const job = jobStore.getJob(jobId);
      return {
        ...job,
        status: deriveJobStatus(job)
      };
    },
    getJobItems(jobId) {
      return jobStore.getJobItems(jobId);
    },
    updateJobItem(jobId, itemId, patch = {}) {
      return jobStore.updateJobItem(jobId, itemId, patch);
    }
  };
}

function createStaticManifest(projectRoot) {
  const appsRoot = path.join(projectRoot, 'apps');

  return {
    entrypoints: new Map([
      ['/', { filePath: path.join(appsRoot, 'shell-ui', 'index.html'), baseHref: '/' }],
      ['/download', { filePath: path.join(appsRoot, 'download-ui', 'index.html'), baseHref: '/download/' }],
      ['/clean', { filePath: path.join(appsRoot, 'clean-ui', 'index.html'), baseHref: '/clean/' }],
      ['/translate', { filePath: path.join(appsRoot, 'translate-ui', 'index.html'), baseHref: '/translate/' }],
      ['/export', { filePath: path.join(appsRoot, 'export-ui', 'index.html'), baseHref: '/export/' }]
    ]),
    exactFiles: new Map([
      ['/app.js', path.join(appsRoot, 'shell-ui', 'app.js')]
    ]),
    directoryPrefixes: [
      { prefix: '/download/', rootDir: path.join(appsRoot, 'download-ui') },
      { prefix: '/clean/', rootDir: path.join(appsRoot, 'clean-ui') },
      { prefix: '/translate/', rootDir: path.join(appsRoot, 'translate-ui') },
      { prefix: '/export/', rootDir: path.join(appsRoot, 'export-ui') },
      { prefix: '/shared/', rootDir: path.join(appsRoot, 'shared') }
    ]
  };
}

function normalizeEntrypointPath(pathname) {
  if (pathname !== '/' && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function injectBaseHref(html, baseHref) {
  if (/<base\s/i.test(html)) {
    return html;
  }

  return html.replace(/<head>/i, `<head>\n    <base href="${baseHref}" />`);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

async function sendStaticFile(response, filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = STATIC_TYPES[extension] || 'application/octet-stream';
  let content = await readFile(filePath);

  if (options.baseHref) {
    content = injectBaseHref(content.toString('utf8'), options.baseHref);
  }

  response.writeHead(200, { 'content-type': contentType });
  response.end(content);
}

function resolveStaticAsset(pathname, manifest) {
  const exactMatch = manifest.exactFiles.get(pathname);
  if (exactMatch) {
    return exactMatch;
  }

  for (const mapping of manifest.directoryPrefixes) {
    if (!pathname.startsWith(mapping.prefix)) {
      continue;
    }

    const relativePath = pathname.slice(mapping.prefix.length);
    if (!relativePath) {
      return null;
    }

    const decodedRelativePath = decodeURIComponent(relativePath);
    const resolvedPath = path.resolve(mapping.rootDir, decodedRelativePath);
    if (!isPathInsideRoot(resolvedPath, mapping.rootDir)) {
      return null;
    }

    return resolvedPath;
  }

  return null;
}

async function handleStaticRequest(request, response, url, manifest) {
  if (request.method !== 'GET') {
    return false;
  }

  const entrypointPath = normalizeEntrypointPath(url.pathname);
  const entrypoint = manifest.entrypoints.get(entrypointPath);
  if (entrypoint) {
    try {
      await sendStaticFile(response, entrypoint.filePath, { baseHref: entrypoint.baseHref });
    } catch {
      sendText(response, 404, 'Not found');
    }
    return true;
  }

  const staticAssetPath = resolveStaticAsset(url.pathname, manifest);
  if (!staticAssetPath) {
    return false;
  }

  try {
    await sendStaticFile(response, staticAssetPath);
  } catch {
    sendText(response, 404, 'Not found');
  }

  return true;
}

export function createAppServer(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const jobStore = withDerivedJobStatus(options.jobStore ?? createJobStore());
  const services = {
    download: createDownloadService(),
    clean: createCleanService(),
    translate: createTranslateService(),
    export: createExportService(),
    ...options.services
  };
  const staticManifest = createStaticManifest(projectRoot);

  const routes = [
    createConfigRoute({ projectRoot }),
    createFilesRoute({ projectRoot }),
    createDownloadRoute({ jobStore, projectRoot, service: services.download }),
    createCleanRoute({ jobStore, projectRoot, service: services.clean }),
    createTranslateRoute({ jobStore, projectRoot, service: services.translate }),
    createExportRoute({ jobStore, projectRoot, service: services.export }),
    createJobsRoute({ jobStore })
  ];

  return http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

    Promise.resolve()
      .then(async () => {
        for (const route of routes) {
          if (await route(request, response, url)) {
            return;
          }
        }

        if (await handleStaticRequest(request, response, url, staticManifest)) {
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          sendJson(response, 404, { ok: false, error: 'Route not found' });
          return;
        }

        sendText(response, 404, 'Not found');
      })
      .catch((error) => {
        if (url.pathname.startsWith('/api/')) {
          sendJson(response, 500, { ok: false, error: error.message });
          return;
        }

        sendText(response, 500, error.message);
      });
  });
}
