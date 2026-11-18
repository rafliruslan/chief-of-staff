/**
 * Voice clips, heard before the agent runs.
 *
 * The owner talks to the agent by sending a Slack voice clip, and gets text
 * back. The agent itself has no ears: on 2026-11-02 it was handed a clip as an
 * attachment, installed a speech model in /tmp in the middle of the turn, got
 * Malay gibberish, and ended by asking what he had said. Slack transcribes
 * clips for people, but documents no transcript a bot can read. So the bridge
 * transcribes each clip on this Mac before the run starts, and the agent reads
 * the words like any other message from the sender.
 *
 * The transcriber is mlx-whisper (`uv tool install mlx-whisper`) with
 * whisper-large-v3-turbo, on the GPU and offline: a 10 second clip in English
 * or Indonesian takes 3 to 5 seconds. Names are its weak point, so an optional
 * file of names beside the env file (`stt-prompt.txt`, kept out of the repo)
 * is passed as its initial prompt.
 *
 * A clip that cannot be heard says so, and tells the agent not to guess.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadSlackFile } from './slack-tools.mjs';

export const DEFAULT_STT_MODEL = 'mlx-community/whisper-large-v3-turbo-q4';
export const DEFAULT_STT_BIN = join(homedir(), '.local', 'bin', 'mlx_whisper');
const MAX_CLIPS = 3;
const MAX_CHARS = 4000;
const TIMEOUT_MS = 120_000;

/** A Slack voice clip, or any audio file sent as a message. */
export function isVoiceClip(f) {
  if (!f || !f.id) return false;
  return /^audio\//i.test(String(f.mimetype || '')) || f.subtype === 'slack_audio';
}

/** The transcript as it goes into the prompt: one line, no quotes to break out of, capped. */
export function cleanTranscript(text) {
  const one = String(text || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > MAX_CHARS ? `${one.slice(0, MAX_CHARS)}… (cut short)` : one;
}

const label = (f) => String(f.name || f.title || 'clip').replace(/[\u0000-\u001f"]+/g, ' ').trim().slice(0, 80);
const failed = (f, why) =>
  `[voice clip "${label(f)}", id ${f.id}: could not be transcribed (${String(why).split('\n')[0].slice(0, 200)}). Say so; do not guess what it said.]`;

/**
 * Run mlx-whisper on one file and return { text, language }.
 * Offline: the model must already be in the Hugging Face cache.
 */
export function runWhisper(path, { bin = DEFAULT_STT_BIN, model = DEFAULT_STT_MODEL, prompt = '', outDir, timeoutMs = TIMEOUT_MS } = {}) {
  const args = ['--model', model, '-f', 'json', '-o', outDir, '--output-name', 'clip', '--verbose', 'False'];
  if (prompt) args.push('--initial-prompt', prompt);
  args.push(path);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, HF_HUB_OFFLINE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${bin} is not installed`) : e);
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const last = err.trim().split('\n').at(-1) || '';
        return reject(new Error(signal === 'SIGKILL' ? `took over ${timeoutMs / 1000}s` : `exit ${code}${last ? `: ${last}` : ''}`));
      }
      try {
        const out = JSON.parse(await readFile(join(outDir, 'clip.json'), 'utf8'));
        resolve({ text: out.text || '', language: out.language || '' });
      } catch (e) {
        reject(new Error(`no transcript written: ${e.message}`));
      }
    });
  });
}

async function hearOne(f, { token, client, fetchFn, run, prompt, bin, model }) {
  let dir;
  try {
    let url = f.url_private_download || f.url_private;
    if (!url && client) {
      const { file } = await client.files.info({ file: f.id });
      url = file?.url_private_download || file?.url_private;
    }
    if (!url) return failed(f, 'Slack gave no download link');
    const got = await downloadSlackFile(url, { token, fetchFn });
    if (got.error) return failed(f, got.error);
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-'));
    const ext = (String(f.name || '').match(/\.(m4a|mp3|mp4|wav|webm|ogg|aac|caf|flac)$/i) || ['.m4a'])[0].toLowerCase();
    const path = join(dir, `in${ext}`);
    await writeFile(path, got.bytes, { mode: 0o600 });
    const { text, language } = await run(path, { bin, model, prompt, outDir: dir });
    const said = cleanTranscript(text);
    if (!said) return `[voice clip "${label(f)}", id ${f.id}: no speech heard in it.]`;
    return (
      `[voice clip "${label(f)}", id ${f.id}, transcribed on this Mac${language ? ` (${language})` : ''}. ` +
      `Names, numbers and amounts may be misheard: read back any that matter before acting on them. ` +
      `What was said: "${said}"]`
    );
  } catch (e) {
    return failed(f, e?.message || e);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * One line per voice clip in `files`, with what was said, or '' when there
 * are none. Never throws: a clip that fails gets a line saying so.
 *
 * @param {Array} files  the message's Slack file objects
 * @param {object} ctx   { token, client, env, promptPath, fetchFn, run }
 */
export async function hearClips(files, { token, client, env = process.env, promptPath = '', fetchFn = fetch, run = runWhisper } = {}) {
  const clips = (Array.isArray(files) ? files : []).filter(isVoiceClip).slice(0, MAX_CLIPS);
  if (!clips.length) return '';
  let prompt = '';
  if (promptPath) {
    try {
      prompt = (await readFile(promptPath, 'utf8')).replace(/\s+/g, ' ').trim().slice(0, 800);
    } catch {
      // No names file: transcribe without one.
    }
  }
  const ctx = { token, client, fetchFn, run, prompt, bin: env.STT_BIN || DEFAULT_STT_BIN, model: env.STT_MODEL || DEFAULT_STT_MODEL };
  const lines = [];
  for (const f of clips) lines.push(await hearOne(f, ctx));
  return lines.join('\n');
}
