import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, unreplied, inboxRows, decide, runProbe, readSentinel, fingerprint, WA_LIST_JS } from './probes.mjs';

test('a probe line parses, and an unknown one does not', () => {
  const p = parseProbe('slack-unreplied C0B1 since=1794979800 match=Order #\\d+ paid');
  assert.equal(p.kind, 'slack-unreplied');
  assert.equal(p.channel, 'C0B1');
  assert.equal(p.since, 1794979800);
  assert.ok(p.match.test(':white_check_mark: Order #1101 paid'));
  assert.deepEqual(parseProbe('whatsapp-inbox'), { kind: 'whatsapp-inbox' });
  assert.equal(parseProbe('gmail-unread'), null);
  assert.equal(parseProbe('slack-unreplied C0B1 since=1 match=(['), null);
});

test('only matching top-level posts the bot has not answered count', () => {
  const msgs = [
    { ts: '200', text: 'Order #1102 paid', reply_users: ['UBOT'] },
    { ts: '300', text: 'Order #1103 paid', reply_users: ['UTEAM'] },
    { ts: '250', text: 'Order #1104 paid' },
    { ts: '100', text: 'Order #1090 paid' },
    { ts: '400', text: 'someone chatting' },
    { ts: '500', thread_ts: '300', text: 'Order #1105 paid' },
  ];
  assert.deepEqual(unreplied(msgs, { since: 150, match: /^Order #\d+ paid/, self: 'UBOT' }), ['250', '300']);
});

test('WhatsApp rows: unread DMs and tagged groups, never an untagged group', () => {
  const rows = [
    { title: '+62 812-0000-0000', preview: 'Halo kak', unread: 1 },
    { title: 'Ana', preview: 'read already', unread: 0 },
    { title: 'A1C MALAYSIA', preview: 'Budi: morning all', unread: 4 },
    { title: 'Some group', preview: 'Budi: @A1C can you check', unread: 1 },
    { title: 'Other group', preview: 'Sari: see this', unread: 2, tagged: true },
    { title: 'WhatsApp Business', preview: 'tips', unread: 1 },
    { title: 'Unknown group', preview: 'no prefix here', unread: 3, group: true },
  ];
  const got = inboxRows(rows, { groups: ['A1C MALAYSIA'], tags: ['@A1C'] }).map((r) => r.title);
  assert.deepEqual(got, ['+62 812-0000-0000', 'Some group', 'Other group']);
});

test('the same answer as the last good run waits for the retry window', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const res = { open: true, reason: '1 chat', fingerprint: 'abc' };
  assert.equal(decide(res, null, now).run, true);
  assert.equal(decide(res, { fp: 'zzz', at: '2026-11-22T09:55:00Z' }, now).run, true);
  assert.equal(decide(res, { fp: 'abc', at: '2026-11-22T09:55:00Z' }, now).run, false);
  assert.equal(decide(res, { fp: 'abc', at: '2026-11-22T08:59:00Z' }, now).run, true);
  assert.equal(decide({ open: false, reason: 'none' }, null, now).run, false);
});

test('a probe that cannot decide opens', async () => {
  const broken = { slack: async () => { throw new Error('no token'); } };
  assert.equal((await runProbe({ kind: 'slack-unreplied', channel: 'C1', since: 0, match: /x/ }, broken)).open, true);
  const signedOut = { repl: async () => `@@PROBE@@${JSON.stringify({ state: 'qr', rows: [] })}` };
  assert.equal((await runProbe({ kind: 'whatsapp-inbox' }, signedOut)).open, true);
  const silent = { repl: async () => 'Error: no browser' };
  assert.equal((await runProbe({ kind: 'whatsapp-inbox' }, silent)).open, true);
});

test('probes close on a quiet channel and a quiet inbox', async () => {
  const slack = async () => ({
    auth: { test: async () => ({ user_id: 'UBOT' }) },
    conversations: { history: async () => ({ messages: [{ ts: '9', text: 'Order #1 paid', reply_users: ['UBOT'] }] }) },
  });
  assert.equal((await runProbe(parseProbe('slack-unreplied C1 since=1 match=paid'), { slack })).open, false);
  const repl = async () => `x\n@@PROBE@@${JSON.stringify({ state: 'ok', rows: [{ title: 'Ana', preview: 'hi', unread: 0 }] })}\n`;
  assert.equal((await runProbe({ kind: 'whatsapp-inbox' }, { repl })).open, false);
});

test('fingerprints ignore order, and the sentinel line is found among others', () => {
  assert.equal(fingerprint(['a', 'b']), fingerprint(['b', 'a']));
  assert.deepEqual(readSentinel('noise\n@@PROBE@@{"state":"ok"}\nmore'), { state: 'ok' });
  assert.equal(readSentinel('nothing'), null);
});

import { rollProbe } from './probes.mjs';

const ROLL = parseProbe('roll SEA=0900-1130 EU=1600-1730 daily=0b: weekly=WEEKLY');
const halfHourly = (d) => d.getMinutes() % 30 === 0;
const file = (posted, log) => `# R\n\n## Posted\n\nFormat: date | window\n\n${posted}\n\n## Log\n\n${log}\n`;
const at = (s) => new Date(s); // local time, as the runner sees it

test('the roll waits for nothing when a daily job is not done today', () => {
  const r = rollProbe(ROLL, { text: file('', '- 2026-11-20 09:00: 0b: scored 3'), now: at('2026-11-20T13:00:00'), firesAt: halfHourly, random: () => 0.99 });
  assert.equal(r.open, false, 'done today, outside a window');
  const due = rollProbe(ROLL, { text: file('', '- 2026-11-19 09:00: 0b: scored 3'), now: at('2026-11-20T13:00:00'), firesAt: halfHourly, random: () => 0.99 });
  assert.equal(due.open, true);
  assert.match(due.reason, /daily job/);
});

test('Sunday opens until the weekly line is in the Log', () => {
  const sun = at('2026-11-22T13:00:00');
  const log = '- 2026-11-22 09:00: 0b: scored 2';
  assert.equal(rollProbe(ROLL, { text: file('', log), now: sun, firesAt: halfHourly, random: () => 0.99 }).open, true);
  assert.equal(rollProbe(ROLL, { text: file('', `${log} WEEKLY posted`), now: sun, firesAt: halfHourly, random: () => 0.99 }).open, false);
});

test('in a window: closed once posted, else 1 in the firings left', () => {
  const log = '- 2026-11-20 09:00: 0b: scored 3';
  const now = at('2026-11-20T10:30:00');
  const posted = '- 2026-11-20 | SEA | EN | no | someone | https://x | hi';
  assert.match(rollProbe(ROLL, { text: file(posted, log), now, firesAt: halfHourly, random: () => 0 }).reason, /already posted/);
  const pass = rollProbe(ROLL, { text: file('- 2026-11-20 | EU | EN', log), now, firesAt: halfHourly, random: () => 0.3 });
  assert.equal(pass.open, true);
  assert.match(pass.reason, /1 in 3/);
  assert.equal(rollProbe(ROLL, { text: file('', log), now, firesAt: halfHourly, random: () => 0.34 }).open, false);
  const last = rollProbe(ROLL, { text: file('', log), now: at('2026-11-20T11:30:00'), firesAt: halfHourly, random: () => 0.99 });
  assert.equal(last.open, true, 'the last firing always passes');
});

test('gmail-new: the newest unread time per account is the fingerprint', async () => {
  const p = parseProbe('gmail-new accounts=0,2');
  assert.deepEqual(p, { kind: 'gmail-new', accounts: [0, 2] });
  const repl = async () => `@@PROBE@@${JSON.stringify({ state: 'ok', newest: { 0: 100, 2: 0 } })}`;
  const r = await runProbe(p, { repl });
  assert.equal(r.fingerprint, '0:100|2:0');
  const now = Date.parse('2026-11-22T10:00:00Z');
  assert.equal(decide(r, { fp: '0:100|2:0', at: '2026-11-22T09:30:00Z' }, now, 120).run, false, 'no new mail, inside the retry window');
  assert.equal(decide(r, { fp: '0:90|2:0', at: '2026-11-22T09:30:00Z' }, now, 120).run, true, 'new mail');
  assert.equal(decide(r, { fp: '0:100|2:0', at: '2026-11-22T07:59:00Z' }, now, 120).run, true, 'full scan due');
  const signedOut = async () => `@@PROBE@@${JSON.stringify({ state: 'ok', newest: { 0: 'http 401', 2: 0 } })}`;
  assert.equal((await runProbe(p, { repl: signedOut })).fingerprint, undefined, 'an unreadable feed never matches, so it runs');
});

test('the roll counts the last firing of the window when the tick runs a few seconds late', () => {
  const r = rollProbe(ROLL, { text: file('', '- 2026-11-20 09:00: 0b: scored 3'), now: at('2026-11-20T11:00:07'), firesAt: halfHourly, random: () => 0.6 });
  assert.equal(r.open, false);
  assert.match(r.reason, /1 in 2/);
});

/** Run the WhatsApp script with a fake browser. `tabs` maps a targetId to what that tab shows. */
async function runWaList(tabs, opened = 'ok', url = 'https://web.whatsapp.com/') {
  const calls = { opened: 0, closed: 0, out: '' };
  const tab = (shows) => ({
    n: 0,
    async evaluate() { return this.n++ === 0 ? shows : [{ title: 'Ana', unread: 1 }]; },
  });
  const AsyncFunction = (async () => {}).constructor;
  const run = new AsyncFunction('listBrowserTabs', 'attachBrowserTab', 'openTab', 'closeTab', 'setTimeout', 'console', WA_LIST_JS);
  await run(
    async () => Object.keys(tabs).map((targetId) => ({ targetId, url })),
    async (id) => tab(tabs[id]),
    async () => { calls.opened += 1; return tab(opened); },
    async () => { calls.closed += 1; },
    (fn) => fn(),
    { log: (x) => { calls.out += x; } },
  );
  return { ...calls, state: readSentinel(calls.out).state };
}

test('the WhatsApp probe reads an open chat list in place, so it never takes the session', async () => {
  const r = await runWaList({ A: 'ok' });
  assert.deepEqual([r.state, r.opened, r.closed], ['ok', 0, 0]);
});

test('with no usable WhatsApp tab the probe opens its own and closes it', async () => {
  const none = await runWaList({});
  assert.deepEqual([none.state, none.opened, none.closed], ['ok', 1, 1]);
  const stale = await runWaList({ A: 'busy' });
  assert.deepEqual([stale.state, stale.opened, stale.closed], ['ok', 1, 1]);
  const qr = await runWaList({}, 'qr');
  assert.deepEqual([qr.state, qr.closed], ['qr', 1]);
});

test('a tab on a lookalike host is never read', async () => {
  for (const url of ['https://web.whatsapp.com.example.net/', 'https://web.whatsapp.com@example.net/', 'http://web.whatsapp.com/', '']) {
    const r = await runWaList({ A: 'ok' }, 'qr', url);
    assert.deepEqual([r.state, r.opened], ['qr', 1], url);
  }
});
