import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrain, termDrainMs, DRAIN_MAX_MS } from './drain.mjs';

const quiet = { log() {}, warn() {} };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('an idle bridge exits at once', async () => {
  const c = clock();
  let stopped = false;
  const d = createDrain({ busy: () => 0, onStart: () => { stopped = true; }, ...c, log: quiet });
  assert.equal(d.draining, false);
  assert.equal(await d.start('SIGTERM'), true);
  assert.equal(d.draining, true);
  assert.equal(stopped, true, 'intake stops even when nothing is running');
  assert.equal(c.now(), 0);
});

test('a busy bridge waits until its runs finish', async () => {
  const c = clock();
  let running = 2;
  const sleep = async (ms) => { await c.sleep(ms); if (c.now() >= 5000) running = 0; };
  const lines = [];
  const d = createDrain({ busy: () => running, now: c.now, sleep, log: { log: (s) => lines.push(s), warn() {} } });
  assert.equal(await d.start('SIGTERM'), true);
  assert.equal(c.now(), 5000);
  assert.match(lines[0], /SIGTERM: finishing 2 run\(s\) before exiting/);
  assert.match(lines[1], /runs finished after 5s/);
});

test('the wait is capped', async () => {
  const c = clock();
  const warned = [];
  const d = createDrain({ busy: () => 1, ...c, log: { log() {}, warn: (s) => warned.push(s) } });
  assert.equal(await d.start('SIGTERM', { maxMs: 50_000 }), false);
  assert.equal(c.now(), 50_000);
  assert.match(warned[0], /1 run\(s\) still going after 50s; exiting anyway/);
});

test('SIGTERM during a long drain brings the end closer, never further', async () => {
  const c = clock();
  const d = createDrain({ busy: () => 1, ...c, log: quiet });
  const wait = d.start('SIGHUP');
  d.start('SIGTERM', { maxMs: 50_000 });
  d.start('SIGHUP');
  assert.equal(await wait, false);
  // The first poll has already slept when SIGTERM lands: 1s in, then 50s.
  assert.equal(c.now(), 51_000);
});

test('SIGTERM waits less on macOS, where launchd kills after 60s', () => {
  assert.ok(termDrainMs('darwin') < 60_000);
  assert.equal(termDrainMs('linux'), DRAIN_MAX_MS);
});

test('a second signal shares the first wait', async () => {
  const c = clock();
  let starts = 0;
  const d = createDrain({ busy: () => 0, onStart: () => { starts += 1; }, ...c, log: quiet });
  const a = d.start('SIGTERM');
  const b = d.start('SIGINT');
  assert.equal(a, b);
  await a;
  assert.equal(starts, 1);
});
