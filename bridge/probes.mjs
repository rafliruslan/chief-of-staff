/**
 * PROBES. A cheap look, with no model, before a routine starts one.
 *
 * Most watcher runs find nothing. Over two weeks in 2026-11 an orders watcher
 * started a model 900 times and posted nothing, and a WhatsApp watcher found
 * nothing new in 367 of 428 runs. Each of those runs paid for a full session to
 * learn that. A probe asks the same question through the Slack API or one
 * `aside repl` script, and the runner starts the model only when the answer
 * could be yes.
 *
 * A routine opts in with one frontmatter line:
 *
 *   probe: "slack-unreplied <channel> since=<ts> match=<regex>"
 *       Open when a top-level post in <channel> at or after <ts> matches
 *       <regex> and the bot has not replied in its thread.
 *   probe: "whatsapp-inbox"
 *       Open when the WhatsApp chat list holds an unread one-to-one chat or a
 *       group that tags the account. Reads the list only, never opens a chat.
 *   probe: "gmail-new accounts=0,1,2"
 *       Open when the newest unread mail in any of those Gmail accounts (/mail/u/N)
 *       differs from the last good run's. Reads each inbox's Atom feed in one
 *       tab and closes it. Pair it with `probe_retry` so the full scan still runs
 *       every few hours for what mail does not announce (a meeting coming up).
 *   probe: "roll SEA=0900-1130 EU=1600-1730 daily=0b: weekly=WEEKLY"
 *       For a routine that acts once per named window per day at a random
 *       firing. Open when a daily (or Sunday) job has no Log line today; else
 *       closed outside a window or when the window has a `## Posted` row today;
 *       else roll 1 in (firings left in the window). The runner tells the model
 *       the roll passed, so it does not roll again.
 *
 * Every probe returns { open, reason, fingerprint }. The runner keeps the
 * fingerprint of the last successful run and skips a repeat of it for
 * `probe_retry` minutes (60 by default), so an unread chat nobody answers does
 * not wake the model every ten minutes, and a run that failed still gets
 * another try within the hour. A probe that cannot decide (API error, page
 * not loaded, WhatsApp signed out) opens: the model's run is what reports a
 * source as down, and a probe must never hide that.
 */

import { createHash } from 'node:crypto';

export const DEFAULT_RETRY_MIN = 60;

/** The frontmatter `probe:` value as an object, or null when it is not one we know. */
export function parseProbe(spec) {
  const s = String(spec ?? '').trim();
  if (s === 'whatsapp-inbox') return { kind: 'whatsapp-inbox' };
  if (s.startsWith('roll ')) return parseRoll(s.slice(5));
  const g = s.match(/^gmail-new\s+accounts=([\d,]+)$/);
  if (g) return { kind: 'gmail-new', accounts: g[1].split(',').map(Number) };
  const m = s.match(/^slack-unreplied\s+([CDG][A-Z0-9]+)\s+since=(\d+(?:\.\d+)?)\s+match=(.+)$/);
  if (!m) return null;
  try {
    return { kind: 'slack-unreplied', channel: m[1], since: Number(m[2]), match: new RegExp(m[3]) };
  } catch {
    return null;
  }
}

function parseRoll(rest) {
  const windows = [];
  let daily = null;
  let weekly = null;
  for (const tok of rest.trim().split(/\s+/)) {
    const w = tok.match(/^([A-Za-z]+)=(\d{4})-(\d{4})$/);
    if (w) windows.push({ name: w[1], from: Number(w[2]), to: Number(w[3]) });
    else if (tok.startsWith('daily=')) daily = tok.slice(6);
    else if (tok.startsWith('weekly=')) weekly = tok.slice(7);
    else return null;
  }
  return windows.length ? { kind: 'roll', windows, daily, weekly } : null;
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => d.getHours() * 100 + d.getMinutes();

/** The `- YYYY-MM-DD...` lines of a `## <heading>` section dated `day`. */
function linesOn(text, heading, day) {
  const m = String(text).match(new RegExp(`^## ${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].split('\n').filter((l) => l.startsWith(`- ${day}`)) : [];
}

/**
 * The roll, without a model. `firesAt(date)` says whether the routine's schedule
 * fires at that minute; `random` is injectable for tests.
 */
export function rollProbe(probe, { text, now = new Date(), firesAt, random = Math.random }) {
  const day = dayOf(now);
  const log = linesOn(text, 'Log', day);
  if (probe.daily && !log.some((l) => l.includes(probe.daily))) return { open: true, reason: `daily job (${probe.daily}) not done today` };
  if (probe.weekly && now.getDay() === 0 && !log.some((l) => l.includes(probe.weekly))) {
    return { open: true, reason: `Sunday job (${probe.weekly}) not done today` };
  }
  const t = hhmm(now);
  const w = probe.windows.find((x) => t >= x.from && t <= x.to);
  if (!w) return { open: false, reason: 'outside every window' };
  if (linesOn(text, 'Posted', day).some((l) => l.split('|')[1]?.trim() === w.name)) {
    return { open: false, reason: `${w.name} already posted today` };
  }
  let left = 0;
  // From the start of this minute: the runner ticks a few seconds past it, and
  // counting from 11:00:05 used to stop short of an 11:30:00 firing.
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(now);
  end.setHours(Math.floor(w.to / 100), w.to % 100, 0, 0);
  for (let d = start; d <= end; d = new Date(d.getTime() + 60_000)) if (firesAt(d)) left += 1;
  left = Math.max(left, 1);
  return random() < 1 / left
    ? { open: true, reason: `roll passed (1 in ${left}) for ${w.name}` }
    : { open: false, reason: `roll failed (1 in ${left})` };
}

export const fingerprint = (items) =>
  createHash('sha256').update(JSON.stringify([...items].sort())).digest('hex').slice(0, 16);

/** Top-level posts that match and that `self` has not replied to, oldest first. */
export function unreplied(messages, { since, match, self }) {
  return (messages || [])
    .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
    .filter((m) => Number(m.ts) >= since && match.test(String(m.text || '')))
    .filter((m) => !(m.reply_users || []).includes(self))
    .map((m) => m.ts)
    .sort((a, b) => Number(a) - Number(b));
}

/**
 * Chat-list rows worth a model's look: unread, not WhatsApp's own row, and either
 * a one-to-one chat or a group that tags the account. A row counts as a group
 * when the page shows a sender line, its name is a known group, or its preview
 * starts with a sender ("Ana: hi").
 * When in doubt a row is kept: the model applies the routine's full rules, and the
 * fingerprint stops it coming back every run.
 */
export function inboxRows(rows, { groups = [], tags = [] } = {}) {
  const known = new Set(groups);
  return (rows || []).filter((r) => {
    if (!r.unread) return false;
    if (/^WhatsApp( Business)?$/i.test(r.title || '')) return false;
    const preview = String(r.preview || '');
    const group = Boolean(r.group) || known.has(r.title) || /^~?\s?[^:]{1,40}:\s/.test(preview);
    if (!group) return true;
    return Boolean(r.tagged) || tags.some((t) => preview.includes(t));
  });
}

/** Whether a probe's answer starts a run, given what the last successful run saw. */
export function decide(result, last, now = Date.now(), retryMin = DEFAULT_RETRY_MIN) {
  if (!result.open) return { run: false, reason: result.reason };
  if (!result.fingerprint || !last?.fp || last.fp !== result.fingerprint) return { run: true, reason: result.reason };
  const age = now - Date.parse(last.at || 0);
  if (age >= retryMin * 60_000) return { run: true, reason: `${result.reason}, same as ${Math.round(age / 60_000)} min ago, retrying` };
  return { run: false, reason: `${result.reason}, unchanged since the last run` };
}

const SENTINEL = '@@PROBE@@';

/**
 * One `aside repl` script: read the WhatsApp chat list and print it. Clicks nothing.
 * WhatsApp Web works in one tab at a time, and a new tab takes the session from
 * the old one. So a tab that already shows the list is read where it is; only
 * when there is none does this open its own, and it closes that one.
 */
export const WA_LIST_JS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WA = 'https://web.whatsapp.com';
const isWa = (u) => { try { return new URL(u).origin === WA; } catch { return false; } };
const look = (p) => p.evaluate((wa) => {
  if (location.origin !== wa) return 'loading';
  if (document.querySelector('#pane-side [role="row"]')) return 'ok';
  const t = document.body ? document.body.innerText : '';
  if (/use here/i.test(t) && /another window/i.test(t)) return 'busy';
  if (document.querySelector('canvas[aria-label*="QR" i], [data-ref]')) return 'qr';
  return 'loading';
}, WA);
let page = null;
let own = false;
let state = 'loading';
for (const t of (await listBrowserTabs()).filter((x) => isWa(x.url))) {
  const p = await attachBrowserTab(t.targetId).catch(() => null);
  if (p && (await look(p).catch(() => 'loading')) === 'ok') { page = p; state = 'ok'; break; }
}
if (!page) {
  page = await openTab('https://web.whatsapp.com/');
  own = true;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    state = await look(page);
    if (state !== 'loading') break;
    await sleep(1000);
  }
}
let rows = [];
if (state === 'ok') {
  await sleep(1500);
  rows = await page.evaluate((wa) => location.origin !== wa ? null : [...document.querySelectorAll('#pane-side [role="row"]')].slice(0, 15).map((r) => {
    const titles = [...r.querySelectorAll('span[title]')].map((s) => s.getAttribute('title'));
    const labels = [...r.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') || '');
    const unread = labels.find((a) => /unread message/i.test(a)) || '';
    const n = (unread.match(/(\\d+)\\s+unread/i) || [])[1];
    // A group row prints its sender on a line of its own: "Budi", ":" or "Budi:".
    const lines = (r.innerText || '').split('\\n').map((x) => x.trim()).filter(Boolean);
    return {
      group: lines.some((l) => l === ':' || /^~?\\s?[^:]{1,40}:$/.test(l)),
      title: titles[0] || '',
      preview: (titles[1] || '').slice(0, 200),
      unread: n ? Number(n) : 0,
      tagged: labels.includes('@ message'),
    };
  }), WA);
  if (!rows) { rows = []; state = 'moved'; }
}
if (own) try { await closeTab(page); } catch {}
console.log(${JSON.stringify(SENTINEL)} + JSON.stringify({ state, rows }));
`;

/** One `aside repl` script: newest unread mail time per Gmail account, from the Atom feed. */
export const gmailNewJs = (accounts) => `
const page = await openTab('https://mail.google.com/mail/u/0/');
await new Promise((r) => setTimeout(r, 3000));
const out = await page.evaluate(async (accounts) => {
  const res = {};
  for (const u of accounts) {
    try {
      const r = await fetch('/mail/u/' + u + '/feed/atom', { credentials: 'include' });
      const xml = await r.text();
      const times = [...xml.matchAll(/<entry>[\\s\\S]*?<issued>([^<]+)<\\/issued>/g)].map((m) => Date.parse(m[1]));
      res[u] = r.ok ? (times.length ? Math.max(...times) : 0) : 'http ' + r.status;
    } catch (e) { res[u] = 'error'; }
  }
  return res;
}, ${JSON.stringify(accounts)});
await page.close();
console.log(${JSON.stringify(SENTINEL)} + JSON.stringify({ state: 'ok', newest: out }));
`;

/** The JSON object a probe script printed after the sentinel, or null. */
export function readSentinel(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.includes(SENTINEL));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(SENTINEL) + SENTINEL.length));
  } catch {
    return null;
  }
}

/**
 * Run a probe. `deps` carries the outside world so tests need none of it:
 *   slack()        -> a WebClient, for slack-unreplied
 *   repl(code)     -> stdout of `aside repl`, for whatsapp-inbox
 *   waConfig       -> { groups: [...], tags: [...] } names from the routine and config
 */
export async function runProbe(probe, deps) {
  try {
    if (probe.kind === 'slack-unreplied') {
      const client = await deps.slack();
      const self = (await client.auth.test()).user_id;
      const h = await client.conversations.history({ channel: probe.channel, oldest: String(probe.since), limit: 100 });
      const ts = unreplied(h.messages, { since: probe.since, match: probe.match, self });
      return ts.length
        ? { open: true, reason: `${ts.length} post(s) with no reply`, fingerprint: fingerprint(ts) }
        : { open: false, reason: 'no unreplied posts' };
    }
    if (probe.kind === 'roll') return rollProbe(probe, deps);
    if (probe.kind === 'gmail-new') {
      const out = readSentinel(await deps.repl(gmailNewJs(probe.accounts)));
      const newest = out?.newest || {};
      if (!out || Object.values(newest).some((v) => typeof v !== 'number')) {
        return { open: true, reason: 'Gmail feed unreadable, running anyway' };
      }
      return { open: true, reason: 'Gmail read, newest unread mail changed or full scan due', fingerprint: probe.accounts.map((u) => `${u}:${newest[u]}`).join('|') };
    }
    if (probe.kind === 'whatsapp-inbox') {
      const out = readSentinel(await deps.repl(WA_LIST_JS));
      if (!out) return { open: true, reason: 'probe printed nothing, running anyway' };
      if (out.state !== 'ok') return { open: true, reason: `WhatsApp ${out.state}, running anyway` };
      const rows = inboxRows(out.rows, deps.waConfig || {});
      return rows.length
        ? { open: true, reason: `${rows.length} chat(s) to look at`, fingerprint: fingerprint(rows.map((r) => `${r.title}|${r.unread}|${r.preview}`)) }
        : { open: false, reason: 'no new chats' };
    }
    return { open: true, reason: `unknown probe ${probe.kind}, running anyway` };
  } catch (err) {
    return { open: true, reason: `probe failed (${err.message}), running anyway` };
  }
}
