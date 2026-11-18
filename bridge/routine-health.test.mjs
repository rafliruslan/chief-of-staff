import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGate, sectionItems, checkGate, parseDown, stripDown, trackHealth, parseLog, logLine, appendLog } from './routine-health.mjs';

const HOT = (body) => `# Check\n\n## Hot list\n\nFormat: \`<key> | <window> | <what>\`. Empty means stop.\n\n${body}\n\n**Write-up structure:**\n- a | b | c\n\n## Log\n`;

test('a gate names a file and a heading', () => {
  assert.deepEqual(parseGate('proactive-check.md#Hot list'), { file: 'proactive-check.md', heading: 'Hot list' });
  assert.equal(parseGate('no-hash.md'), null);
  assert.equal(parseGate(undefined), null);
});

test('the empty Hot list as it stands on 2026-11-14 has no items', () => {
  assert.deepEqual(sectionItems(HOT('(empty; ID7265 removed 2026-11-04, window over)'), 'Hot list'), []);
});

test('an item line counts, and nothing past the section does', () => {
  const items = sectionItems(HOT('ID7265 | 2026-11-03 21:00 to 23:59 | FlightAware'), 'Hot list');
  assert.deepEqual(items, ['ID7265 | 2026-11-03 21:00 to 23:59 | FlightAware']);
});

test('a missing heading is not the same as an empty one', () => {
  assert.equal(sectionItems('# nothing here', 'Hot list'), null);
});

test('the gate closes on an empty list and opens on an item', async () => {
  const read = (body) => async () => HOT(body);
  assert.equal((await checkGate('c.md#Hot list', read('(empty)'))).open, false);
  assert.equal((await checkGate('c.md#Hot list', read('x | y | z'))).open, true);
});

test('a gate that cannot be read runs the routine anyway', async () => {
  const gone = async () => { throw new Error('ENOENT'); };
  assert.equal((await checkGate('c.md#Hot list', gone)).open, true);
  assert.equal((await checkGate('c.md#Renamed', async () => HOT(''))).open, true);
  assert.equal((await checkGate('garbage', gone)).open, true);
});

test('down sources come from the last [down: ...] line', () => {
  assert.deepEqual(parseDown('Quiet run.\n[down: Gmail u/2, gmail u/3]'), ['gmail u/2', 'gmail u/3']);
  assert.deepEqual(parseDown('Quiet run.'), []);
  assert.deepEqual(parseDown('[down: none]'), []);
  assert.equal(stripDown('Quiet run.\n[down: slack]'), 'Quiet run.');
});

test('a source down for three runs alerts once, on the third', () => {
  let h;
  const alerts = [];
  for (let i = 0; i < 5; i++) {
    const r = trackHealth(h, { name: 'proactive-check', ok: true, down: ['gmail u/2'], now: Date.UTC(2026, 10, 9, i) });
    h = r.health;
    alerts.push(...r.alerts);
  }
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /gmail u\/2\* for 3 runs .*since 2026-11-09 00:00 UTC/);
  assert.equal(h.sources['gmail u/2'].runs, 5);
});

test('a run that reads the source again starts the count over', () => {
  let { health } = trackHealth(undefined, { name: 'r', ok: true, down: ['slack'], now: 0 });
  ({ health } = trackHealth(health, { name: 'r', ok: true, down: ['slack'], now: 1 }));
  ({ health } = trackHealth(health, { name: 'r', ok: true, down: [], now: 2 }));
  const r = trackHealth(health, { name: 'r', ok: true, down: ['slack'], now: 3 });
  assert.equal(r.health.sources.slack.runs, 1);
  assert.deepEqual(r.alerts, []);
});

test('failed runs alert on the third and leave source counts alone', () => {
  let { health } = trackHealth(undefined, { name: 'r', ok: true, down: ['gmail'], now: 0 });
  const alerts = [];
  for (let i = 0; i < 4; i++) {
    const r = trackHealth(health, { name: 'r', ok: false, now: i, error: 'getaddrinfo ENOTFOUND api.anthropic.com\nstack' });
    health = r.health;
    alerts.push(...r.alerts);
  }
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /failed 3 runs in a row: getaddrinfo ENOTFOUND api.anthropic.com\./);
  assert.equal(health.sources.gmail.runs, 1);
  assert.equal(trackHealth(health, { name: 'r', ok: true, now: 9 }).health.failRuns, 0);
});

test('alert_after from frontmatter is honoured', () => {
  const r = trackHealth(undefined, { name: 'r', ok: true, down: ['x'], now: 0 }, '1');
  assert.equal(r.alerts.length, 1);
});

test('the log line comes from the last [log: ...] line, and none means none', () => {
  assert.equal(parseLog('Quiet.\n[log: IDLE, Hot list empty]\n[down: slack]'), 'IDLE, Hot list empty');
  assert.equal(parseLog('Quiet.'), null);
  assert.equal(parseLog('[log: none]'), null);
  assert.equal(stripDown('Quiet.\n[log: IDLE]\n[down: slack]'), 'Quiet.');
});

test('a log line carries the local date and time', () => {
  assert.equal(logLine('IDLE', new Date(2026, 10, 14, 9, 5)), '- 2026-11-14 09:05: IDLE');
});

test('appending after identical lines works, which Edit could not do', () => {
  const file = '# R\n\n## Log\n\n- 2026-11-14: IDLE\n- 2026-11-14: IDLE\n';
  assert.equal(appendLog(file, '- x'), '# R\n\n## Log\n\n- 2026-11-14: IDLE\n- 2026-11-14: IDLE\n- x\n');
});

test('the line goes at the end of the Log section, not the end of the file', () => {
  const file = '## Log\n\n- a\n\n## What breaks\n\n- b\n';
  assert.equal(appendLog(file, '- c'), '## Log\n\n- a\n- c\n\n## What breaks\n\n- b\n');
});

test('an empty Log section and a missing one both get the line', () => {
  assert.equal(appendLog('## Log\n', '- c'), '## Log\n- c\n');
  assert.equal(appendLog('# R\n', '- c'), '# R\n\n## Log\n\n- c\n');
});

test('log_keep drops the oldest entries and nothing else', () => {
  const file = '## Log\n\nnote kept\n- 1\n- 2\n- 3\n\n## What breaks\n- b\n';
  assert.equal(appendLog(file, '- 4', 2), '## Log\n\nnote kept\n- 3\n- 4\n\n## What breaks\n- b\n');
});

test('a date the run wrote itself is dropped, since the runner adds one', () => {
  assert.equal(parseLog('[log: 2026-11-15 09:00 QUIET. Gmail read]'), 'QUIET. Gmail read');
  assert.equal(parseLog('[log: **2026-11-15**: POSTED]'), 'POSTED');
  assert.equal(parseLog('[log: 3 orders added]'), '3 orders added');
});
