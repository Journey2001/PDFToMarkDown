export class RequestTimeoutError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RequestTimeoutError';
    this.code = 'REQUEST_TIMEOUT';
  }
}

async function readJson(response, url) {
  const rawText = await response.text();
  let data = {};

  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${url}`, { cause: error });
    }
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Request failed: ${url}`);
  }

  return data;
}

function createTimeoutController(timeoutMs, upstreamSignal) {
  if (!(timeoutMs > 0) && !upstreamSignal) {
    return { signal: undefined, cleanup() {} };
  }

  const controller = new AbortController();
  let timeoutId = null;
  let abortedByTimeout = false;
  let removeAbortListener = () => {};

  if (timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, timeoutMs);
  }

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
      removeAbortListener = () => upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  }

  return {
    signal: controller.signal,
    get didTimeout() {
      return abortedByTimeout;
    },
    cleanup() {
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      removeAbortListener();
    }
  };
}

export async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    payload,
    headers = {},
    signal,
    timeoutMs,
    fetchImpl = globalThis.fetch
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }

  const timeoutController = createTimeoutController(timeoutMs, signal);

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        ...headers
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: timeoutController.signal
    });

    return await readJson(response, url);
  } catch (error) {
    if (timeoutController.didTimeout) {
      throw new RequestTimeoutError(`Request timed out: ${url}`, { cause: error });
    }

    throw error;
  } finally {
    timeoutController.cleanup();
  }
}

export async function getJson(url, options = {}) {
  return requestJson(url, {
    ...options,
    method: 'GET'
  });
}

export async function postJson(url, payload, options = {}) {
  return requestJson(url, {
    ...options,
    method: 'POST',
    payload,
    headers: {
      'content-type': 'application/json',
      ...options.headers
    }
  });
}
