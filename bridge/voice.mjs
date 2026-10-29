/**
 * Voice page for the owner: talk to the agent, hear it answer.
 *
 * Slack cannot do live voice with a bot, so this is a small web page. The phone
 * does speech to text and text to speech (Web Speech API); this server only
 * turns each spoken turn into one agent run and returns the text.
 *
 * Reached over Tailscale (`tailscale serve`), which also supplies the HTTPS iOS
 * needs before it lets a page use the microphone. The server itself listens on
 * loopback only, and every request needs the token in ~/.config/agentic-browser/
 * voice-token, so a tailnet device that is not the owner's phone gets nothing.
 *
 * One voice session, kept like a Slack DM: the first turn carries the persona,
 * later turns resume. Every turn is mirrored to the owner's Slack DM as text.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { WebClient } from '@slack/web-api';
import { PERSONA } from './persona.mjs';
import { runAgent } from './runner.mjs';
import { sessionIdFor } from './sessions.mjs';
import { transcriptPathFor } from './mirror.mjs';
import { allowedTools, deniedBrowserTools } from './browser.mjs';
import { splitOutcome } from './status.mjs';
import { DEFAULT_MODEL } from './router.mjs';

const PORT = Number(process.env.VOICE_PORT || 8790);
const CONFIG_DIR = join(homedir(), '.config', 'agentic-browser');
const ENV_PATH = process.env.AGENT_ENV_PATH || join(CONFIG_DIR, 'env');
const TOKEN_PATH = join(CONFIG_DIR, 'voice-token');
const WORKSPACE = process.env.AGENT_WORKSPACE || join(homedir(), '.local', 'share', 'agentic-browser', 'workspace');
const MCP_CONFIG = process.env.AGENT_MCP_CONFIG || join(CONFIG_DIR, 'mcp.json');
const STATE_PATH = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agentic-browser', 'voice.json');
const MAX_BODY = 8 * 1024;
/** `tailscale serve` stamps this header with who is calling, so the owner's own devices need no token. */
const ALLOWED_LOGIN = process.env.VOICE_ALLOWED_LOGIN || '';
/** Hosts the page may be reached by. A rebinding page on another name is refused. */
const ALLOWED_HOSTS = new Set((process.env.VOICE_ALLOWED_HOSTS || `127.0.0.1:${PORT}`).split(',').map((h) => h.trim()).filter(Boolean));

/** Added to every spoken turn: the reply is read aloud, so it must sound like speech. */
const VOICE_NOTE =
  'This turn came by voice and your reply is read aloud. Answer in one or two short spoken sentences. ' +
  'No markdown, no bullets, no emoji, no URLs, no file paths. If the answer needs a list, a link or more than a few sentences, ' +
  'post it to his Slack DM with the Slack tools and say aloud that you did. If a task will take a while, do it, then say the result in one sentence. ' +
  'Still finish with the [status: ...] line; it is stripped before speaking.';

async function loadEnv(path) {
  const out = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function loadToken() {
  try {
    return (await readFile(TOKEN_PATH, 'utf8')).trim();
  } catch {
    const t = randomBytes(24).toString('base64url');
    await mkdir(dirname(TOKEN_PATH), { recursive: true });
    await writeFile(TOKEN_PATH, t + '\n', { mode: 0o600 });
    return t;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { gen: 0, created: false };
  }
}

async function writeState(s) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(s));
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the phone speaks: the reply minus the status line, markup and links. */
export function speakable(text) {
  const { text: body } = splitOutcome(text);
  return body
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>|]+\|([^>]+)>/g, '$1')
    .replace(/[*_`~>#]/g, '')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const env = await loadEnv(ENV_PATH);
  const token = await loadToken();
  const dm = process.env.VOICE_DM_CHANNEL || 'D0BNNKNHQDT';
  const slack = env.SLACK_BOT_TOKEN ? new WebClient(env.SLACK_BOT_TOKEN) : null;
  const tools = await allowedTools(MCP_CONFIG);
  const denied = await deniedBrowserTools(MCP_CONFIG);
  let chain = Promise.resolve();

  async function turn(text) {
    const st = await readState();
    const sessionId = sessionIdFor('voice', st.gen);
    const isNew = !st.created;
    if (isNew) await writeState({ ...st, created: true });
    const prompt = (isNew ? PERSONA : '') + `He said, by voice: "${text}"\n\n---\n\n${VOICE_NOTE}`;
    const result = await runAgent({
      prompt,
      sessionId,
      isNew,
      cwd: WORKSPACE,
      model: DEFAULT_MODEL,
      effort: 'low',
      mcpConfig: MCP_CONFIG,
      allowedTools: tools,
      deniedTools: denied,
      transcriptPath: transcriptPathFor(WORKSPACE, sessionId),
    });
    if (!result.ok && result.deadSession) {
      await writeState({ gen: st.gen + 1, created: false });
      return turn(text);
    }
    return result;
  }

  async function mirror(said, reply) {
    if (!slack) return;
    try {
      await slack.chat.postMessage({ channel: dm, text: `:microphone: *You:* ${said}\n${reply}` });
    } catch (err) {
      console.warn(`[voice] slack mirror failed: ${err.message}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '')) || (origin && new URL(origin).host !== req.headers.host)) {
      res.writeHead(403);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (req.method === 'POST' && url.pathname === '/turn') {
      const login = req.headers['tailscale-user-login'] || '';
      if (!(login && login === ALLOWED_LOGIN) && !sameToken(req.headers['x-voice-token'] || '', token)) {
        res.writeHead(401);
        return res.end('no');
      }
      let body = '';
      for await (const c of req) {
        body += c;
        if (body.length > MAX_BODY) {
          res.writeHead(413);
          return res.end();
        }
      }
      let said = '';
      try {
        said = String(JSON.parse(body).text || '').trim();
      } catch {
        /* falls through */
      }
      if (!said) {
        res.writeHead(400);
        return res.end('empty');
      }
      // One turn at a time: one session cannot be resumed twice at once.
      const run = chain.then(() => turn(said));
      chain = run.catch(() => {});
      try {
        const result = await run;
        const { text: shown } = splitOutcome(result.text || '');
        mirror(said, shown);
        const spoken = result.ok ? speakable(result.text) : 'Sorry Captain, that one failed. Check Slack.';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: spoken || 'Done.' }));
      } catch (err) {
        console.error(`[voice] turn failed: ${err.stack || err.message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: 'Something broke on my side.' }));
      }
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[voice] listening on 127.0.0.1:${PORT}, workspace ${WORKSPACE}`);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Hammock">
<title>Hammock</title>
<style>
  html,body{margin:0;height:100%;background:#0b0710;color:#f3e8ff;font-family:-apple-system,system-ui,sans-serif;overflow:hidden}
  main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:24px;box-sizing:border-box}
  #orb{width:180px;height:180px;border-radius:50%;border:0;background:radial-gradient(circle at 35% 30%,#f9a8d4,#c026d3 60%,#581c87);
    box-shadow:0 0 40px #c026d355;transition:transform .2s,box-shadow .2s;-webkit-tap-highlight-color:transparent}
  #orb.listening{animation:pulse 1.4s ease-in-out infinite;box-shadow:0 0 70px #f472b6aa}
  #orb.thinking{animation:spin 1.2s linear infinite;background:conic-gradient(#c026d3,#f9a8d4,#581c87,#c026d3)}
  #orb.speaking{animation:pulse .7s ease-in-out infinite;box-shadow:0 0 90px #e879f9}
  #orb.off{filter:grayscale(1) brightness(.6);animation:none}
  @keyframes pulse{50%{transform:scale(1.1)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  #state{font-size:15px;opacity:.7;min-height:20px}
  #said{font-size:18px;text-align:center;max-width:90%;min-height:52px;line-height:1.4}
  #hint{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));font-size:12px;opacity:.4}
</style></head><body><main>
<button id="orb" class="off" aria-label="talk"></button>
<div id="state">Tap to start</div>
<div id="said"></div>
<div id="hint">Tap the orb to start, stop, or cut me off</div>
</main>
<script>
(() => {
  const q = new URLSearchParams(location.search);
  if (q.get('t')) { localStorage.setItem('vt', q.get('t')); history.replaceState(null, '', '/'); }
  const token = localStorage.getItem('vt') || '';
  const orb = document.getElementById('orb'), stateEl = document.getElementById('state'), said = document.getElementById('said');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { stateEl.textContent = 'This browser has no speech input. Use Safari.'; return; }
  let on = false, mode = 'off', rec = null, wake = null, ctl = null;
  const set = (m, label) => { mode = m; orb.className = m; stateEl.textContent = label; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function keepAwake() { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }

  function listen() {
    if (!on) return;
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    let final = '';
    rec.onresult = e => {
      let t = ''; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) final = t; }
      said.textContent = t;
    };
    rec.onerror = () => {};
    rec.onend = () => {
      const heard = (final || said.textContent).trim();
      if (!on) return;
      if (heard.length > 1) send(heard); else listen();
    };
    set('listening', 'Listening');
    try { rec.start(); } catch { setTimeout(listen, 400); }
  }

  async function send(text) {
    set('thinking', 'Thinking');
    speak('On it.', true);
    ctl = new AbortController();
    try {
      const r = await fetch('/turn', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-voice-token': token }, body: JSON.stringify({ text }) });
      if (r.status === 401) { said.textContent = 'Not signed in to the tailnet. Turn Tailscale on.'; stop(); return; }
      const j = await r.json();
      if (!on) return;
      said.textContent = j.text;
      await speak(j.text);
    } catch (e) {
      if (e.name !== 'AbortError' && on) { said.textContent = 'Lost the connection.'; await speak('I lost the connection.'); }
    }
    listen();
  }

  function speak(text, quick) {
    return new Promise(res => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')).find(v => /samantha|ava|allison|karen|serena/i.test(v.name));
      if (v) u.voice = v;
      u.rate = 1.03;
      if (!quick) set('speaking', 'Speaking');
      u.onend = u.onerror = () => res();
      speechSynthesis.speak(u);
    });
  }

  function stop() {
    on = false; try { rec && rec.abort(); } catch {}
    ctl && ctl.abort(); speechSynthesis.cancel();
    try { wake && wake.release(); } catch {}
    set('off', 'Tap to start');
  }

  orb.addEventListener('click', () => {
    if (!on) { on = true; said.textContent = ''; keepAwake(); speechSynthesis.speak(new SpeechSynthesisUtterance('')); listen(); return; }
    if (mode === 'speaking') { speechSynthesis.cancel(); return; }
    stop();
  });
})();
</script></body></html>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[voice] failed to start: ${err.stack || err.message}`);
    process.exit(1);
  });
}
