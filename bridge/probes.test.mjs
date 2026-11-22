import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, unreplied, inboxRows, decide, runProbe, readSentinel, fingerprint } from './probes.mjs';

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
