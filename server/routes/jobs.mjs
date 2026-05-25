import { sendJson } from '../shared/http.mjs';

function matchJobPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'jobs') {
    return null;
  }

  let jobId;
  try {
    jobId = decodeURIComponent(parts[2]);
  } catch {
    return {
      invalidJobIdEncoding: true
    };
  }

  return {
    jobId,
    resource: parts[3] ?? null,
    hasExtraSegments: parts.length > 4
  };
}

export function createJobsRoute({ jobStore }) {
  return async function handleJobsRoute(request, response, url) {
    if (request.method !== 'GET') {
      return false;
    }

    const match = matchJobPath(url.pathname);
    if (!match) {
      return false;
    }

    if (match.invalidJobIdEncoding) {
      sendJson(response, 400, { ok: false, error: 'Invalid job id encoding' });
      return true;
    }

    try {
      if (match.hasExtraSegments) {
        sendJson(response, 404, { ok: false, error: 'Route not found' });
        return true;
      }

      if (match.resource === null) {
        sendJson(response, 200, {
          ok: true,
          job: jobStore.getJob(match.jobId)
        });
        return true;
      }

      if (match.resource === 'items') {
        sendJson(response, 200, {
          ok: true,
          jobId: match.jobId,
          items: jobStore.getJobItems(match.jobId)
        });
        return true;
      }

      sendJson(response, 404, { ok: false, error: 'Route not found' });
      return true;
    } catch (error) {
      const statusCode = error.code === 'JOB_NOT_FOUND' ? 404 : 500;
      sendJson(response, statusCode, { ok: false, error: error.message });
      return true;
    }
  };
}
