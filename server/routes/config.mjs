import { sendJson } from '../shared/http.mjs';

const APPS = [
  { id: 'download', label: 'Download', routeBase: '/api/download' },
  { id: 'clean', label: 'Clean', routeBase: '/api/clean' },
  { id: 'translate', label: 'Translate', routeBase: '/api/translate' },
  { id: 'export', label: 'Export', routeBase: '/api/export' },
  { id: 'shell', label: 'Shell', routeBase: '/api/shell' }
];

export function createConfigRoute({ projectRoot }) {
  return async function handleConfigRoute(request, response, url) {
    if (request.method !== 'GET' || url.pathname !== '/api/config') {
      return false;
    }

    sendJson(response, 200, {
      ok: true,
      projectRoot,
      apps: APPS
    });
    return true;
  };
}
