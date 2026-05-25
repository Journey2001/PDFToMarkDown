import { randomUUID } from 'node:crypto';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNil(value) {
  return value === null || value === undefined;
}

function createNotFoundError(message) {
  const error = new Error(message);
  error.code = 'JOB_NOT_FOUND';
  return error;
}

function createItemNotFoundError(message) {
  const error = new Error(message);
  error.code = 'JOB_ITEM_NOT_FOUND';
  return error;
}

function normalizeItems(items = []) {
  return items.map((item, index) => ({
    ...item,
    id: isNil(item?.id) ? `item-${index + 1}` : item.id,
    status: isNil(item?.status) ? 'pending' : item.status
  }));
}

export function createJobStore(options = {}) {
  const jobs = new Map();
  const getNow = typeof options.now === 'function'
    ? options.now
    : () => new Date();

  function requireJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) {
      throw createNotFoundError(`Job not found: ${jobId}`);
    }
    return job;
  }

  return {
    createJob(input = {}) {
      const timestamp = getNow().toISOString();
      const job = {
        id: isNil(input.id) ? randomUUID() : input.id,
        type: input.type ?? 'unknown',
        status: isNil(input.status) ? 'queued' : input.status,
        payload: input.payload ? clone(input.payload) : {},
        items: normalizeItems(input.items),
        createdAt: timestamp,
        updatedAt: timestamp
      };

      jobs.set(job.id, job);
      return clone(job);
    },

    getJob(jobId) {
      return clone(requireJob(jobId));
    },

    getJobItems(jobId) {
      return clone(requireJob(jobId).items);
    },

    updateJobItem(jobId, itemId, patch = {}) {
      const job = requireJob(jobId);
      const itemIndex = job.items.findIndex((item) => item.id === itemId);

      if (itemIndex === -1) {
        throw createItemNotFoundError(`Job item not found: ${itemId}`);
      }

      const normalizedPatch = clone(patch);
      if (isNil(normalizedPatch.id)) {
        delete normalizedPatch.id;
      }
      if (isNil(normalizedPatch.status)) {
        delete normalizedPatch.status;
      }

      const updatedItem = {
        ...job.items[itemIndex],
        ...normalizedPatch,
        id: job.items[itemIndex].id
      };

      if (isNil(updatedItem.status)) {
        updatedItem.status = job.items[itemIndex].status ?? 'pending';
      }

      job.items[itemIndex] = updatedItem;
      job.updatedAt = getNow().toISOString();

      return clone(updatedItem);
    }
  };
}
