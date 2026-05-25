import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobStore } from '../server/shared/job-store.mjs';

test('createJobStore 可以创建并查询任务', () => {
  const store = createJobStore();
  const job = store.createJob({
    type: 'translate',
    status: 'queued',
    payload: { sourceDir: '/tmp/docs' },
    items: [
      { id: 'item-1', name: 'README.md', status: 'pending' },
      { id: 'item-2', name: 'guide.md', status: 'pending' }
    ]
  });

  assert.equal(typeof job.id, 'string');
  assert.equal(job.type, 'translate');
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.payload, { sourceDir: '/tmp/docs' });
  assert.equal(job.items.length, 2);
  assert.match(job.createdAt, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(job.updatedAt, job.createdAt);

  const fetchedJob = store.getJob(job.id);
  assert.notEqual(fetchedJob, job);
  assert.deepEqual(fetchedJob, job);
});

test('createJobStore 可以更新子项状态并同步任务更新时间', () => {
  const timestamps = [
    '2026-05-15T10:00:00.000Z',
    '2026-05-15T10:00:01.000Z'
  ];
  const store = createJobStore({
    now: () => new Date(timestamps.shift())
  });
  const job = store.createJob({
    type: 'clean',
    items: [
      { id: 'item-1', name: 'draft.md', status: 'pending' }
    ]
  });

  const updatedItem = store.updateJobItem(job.id, 'item-1', {
    status: 'completed',
    outputPath: '/tmp/output/draft.md'
  });

  assert.deepEqual(updatedItem, {
    id: 'item-1',
    name: 'draft.md',
    status: 'completed',
    outputPath: '/tmp/output/draft.md'
  });

  const fetchedJob = store.getJob(job.id);
  assert.equal(fetchedJob.items[0].status, 'completed');
  assert.equal(fetchedJob.items[0].outputPath, '/tmp/output/draft.md');
  assert.equal(fetchedJob.createdAt, '2026-05-15T10:00:00.000Z');
  assert.equal(fetchedJob.updatedAt, '2026-05-15T10:00:01.000Z');
});

test('createJobStore 会在任务或子项不存在时抛错', () => {
  const store = createJobStore();
  const job = store.createJob({
    type: 'export',
    items: [{ id: 'item-1', status: 'pending' }]
  });

  assert.throws(() => store.getJob('missing-job'), /Job not found/);
  assert.throws(
    () => store.updateJobItem(job.id, 'missing-item', { status: 'failed' }),
    /Job item not found/
  );
});

test('createJobStore 不允许 null 或 undefined 覆盖默认 id 和 status', () => {
  const store = createJobStore();
  const job = store.createJob({
    id: null,
    status: null,
    items: [
      { id: null, name: 'README.md', status: null },
      { name: 'guide.md', status: undefined }
    ]
  });

  assert.equal(typeof job.id, 'string');
  assert.equal(job.status, 'queued');
  assert.equal(job.items[0].id, 'item-1');
  assert.equal(job.items[0].status, 'pending');
  assert.equal(job.items[1].id, 'item-2');
  assert.equal(job.items[1].status, 'pending');

  const updatedItem = store.updateJobItem(job.id, 'item-1', {
    status: null,
    note: 'kept'
  });

  assert.equal(updatedItem.id, 'item-1');
  assert.equal(updatedItem.status, 'pending');
  assert.equal(updatedItem.note, 'kept');
});
