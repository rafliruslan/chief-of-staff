import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingStore } from './pending.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pending-'));
  try {
    await fn(createPendingStore({ path: join(dir, 'pending.json'), now: () => 1 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('records survive until removed, and takeAll empties the file', () => withStore(async (s) => {
  await s.add('C', '1', { threadTs: '0' });
  assert.equal(await s.remove('C', '2'), false);
  assert.deepEqual(await s.takeAll(), [{ channel: 'C', ts: '1', startedAt: 1, threadTs: '0' }]);
  assert.deepEqual(await s.takeAll(), []);
}));

test('overlapping adds and removes lose nothing', () => withStore(async (s) => {
  await Promise.all(['1', '2', '3', '4', '5'].map((ts) => s.add('C', ts)));
  // Removes racing fresh adds: the removed must stay removed.
  await Promise.all([s.remove('C', '1'), s.add('C', '6'), s.remove('C', '2'), s.add('C', '7'), s.remove('C', '3')]);
  const left = (await s.takeAll()).map((e) => e.ts).sort();
  assert.deepEqual(left, ['4', '5', '6', '7']);
}));
