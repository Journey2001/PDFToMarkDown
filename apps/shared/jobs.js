import { getJson } from './api.js';

export class JobPollingTimeoutError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'JobPollingTimeoutError';
    this.code = 'JOB_POLLING_TIMEOUT';
  }
}

export class JobPollingUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'JobPollingUnavailableError';
    this.code = 'JOB_POLLING_UNAVAILABLE';
  }
}

export function isSettled(status) {
  return status === 'completed' || status === 'failed';
}

function delay(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export async function pollJobUntilSettled(jobId, options = {}) {
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 120000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const onRetryError = typeof options.onRetryError === 'function' ? options.onRetryError : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : delay;
  const getJob = typeof options.getJob === 'function'
    ? options.getJob
    : (targetJobId, requestOptions = {}) => getJson(`/api/jobs/${encodeURIComponent(targetJobId)}`, requestOptions);
  const startedAt = now();
  let consecutiveErrors = 0;

  while (true) {
    if (now() - startedAt >= timeoutMs) {
      throw new JobPollingTimeoutError(`Job polling timed out: ${jobId}`);
    }

    try {
      const payload = await getJob(jobId, { timeoutMs: requestTimeoutMs });
      consecutiveErrors = 0;
      onUpdate(payload.job);

      if (isSettled(payload.job?.status)) {
        return payload.job;
      }
    } catch (error) {
      if (now() - startedAt >= timeoutMs) {
        throw new JobPollingTimeoutError(`Job polling timed out: ${jobId}`, { cause: error });
      }

      consecutiveErrors += 1;
      onRetryError(error, {
        jobId,
        consecutiveErrors
      });

      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new JobPollingUnavailableError(
          `Job polling failed after ${consecutiveErrors} consecutive errors; task may still be running in background: ${jobId}`,
          { cause: error }
        );
      }
    }

    await sleep(intervalMs);
  }
}
