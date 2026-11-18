import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVoiceClip, cleanTranscript, hearClips } from './transcribe.mjs';

const CLIP = { id: 'F0CLIP0001', name: 'Audio Clip (2026-11-02 08:39:16).m4a', mimetype: 'audio/mp4', url_private_download: 'https://files.slack.com/clip.m4a' };
const okFetch = async () => new Response(Buffer.from('fake audio'), { status: 200, headers: { 'content-type': 'audio/mp4' } });

test('a voice clip is audio; a PDF or an image is not', () => {
  assert.equal(isVoiceClip(CLIP), true);
  assert.equal(isVoiceClip({ id: 'F1', subtype: 'slack_audio', mimetype: 'video/mp4' }), true);
  assert.equal(isVoiceClip({ id: 'F2', mimetype: 'application/pdf' }), false);
  assert.equal(isVoiceClip({ id: 'F3', mimetype: 'image/png' }), false);
  assert.equal(isVoiceClip({ mimetype: 'audio/mp4' }), false);
});

test('a transcript becomes one line with no double quotes', () => {
  assert.equal(cleanTranscript(' cek "order"\n1072 \u0007 ya '), "cek 'order' 1072 ya");
  assert.match(cleanTranscript('a'.repeat(5000)), /… \(cut short\)$/);
});

test('no clips, no line', async () => {
  assert.equal(await hearClips([{ id: 'F2', mimetype: 'application/pdf' }]), '');
  assert.equal(await hearClips(undefined), '');
});

test('a clip is downloaded, heard, and its words handed over with a warning about names', async () => {
  let seen;
  const run = async (path, opts) => {
    seen = { path, ...opts };
    return { text: ' Reschedule the weekly alignment to tomorrow at 8. ', language: 'en' };
  };
  const line = await hearClips([CLIP], { token: 'xoxb-test', fetchFn: okFetch, run, env: {} });
  assert.match(line, /^\[voice clip "Audio Clip \(2026-11-02 08:39:16\)\.m4a", id F0CLIP0001, transcribed on this Mac \(en\)\./);
  assert.match(line, /read back any that matter/);
  assert.match(line, /What was said: "Reschedule the weekly alignment to tomorrow at 8\."\]$/);
  assert.match(seen.path, /in\.m4a$/);
  assert.equal(seen.prompt, '');
});

test('the names file is passed as the prompt, and the temp folder is gone after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stt-test-'));
  const names = join(dir, 'stt-prompt.txt');
  await writeFile(names, 'Ana, Budi,\n0spike, Sally');
  let outDir;
  const run = async (_p, opts) => {
    outDir = opts.outDir;
    assert.equal(opts.prompt, 'Ana, Budi, 0spike, Sally');
    return { text: 'kabari Ana', language: 'id' };
  };
  const line = await hearClips([CLIP], { token: 't', fetchFn: okFetch, run, env: {}, promptPath: names });
  assert.match(line, /\(id\).*"kabari Ana"/);
  await assert.rejects(readdir(outDir));
});

test('a failure is reported, never guessed', async () => {
  const run = async () => {
    throw new Error('/x/mlx_whisper is not installed');
  };
  const line = await hearClips([CLIP], { token: 't', fetchFn: okFetch, run, env: {} });
  assert.match(line, /could not be transcribed \(\/x\/mlx_whisper is not installed\)\. Say so; do not guess/);

  const html = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const line2 = await hearClips([CLIP], { token: 't', fetchFn: html, run, env: {} });
  assert.match(line2, /could not be transcribed \(Slack returned a web page/);
});

test('silence says so', async () => {
  const line = await hearClips([CLIP], { token: 't', fetchFn: okFetch, run: async () => ({ text: '  ', language: 'en' }), env: {} });
  assert.match(line, /no speech heard/);
});

test('a clip with no link is looked up, and at most three clips are heard', async () => {
  const client = { files: { info: async () => ({ file: { url_private: 'https://files.slack.com/x.m4a' } }) } };
  let n = 0;
  const run = async () => ({ text: `clip ${++n}`, language: 'en' });
  const bare = (i) => ({ id: `F0CLIP000${i}`, name: `c${i}.m4a`, mimetype: 'audio/mp4' });
  const out = await hearClips([1, 2, 3, 4].map(bare), { token: 't', client, fetchFn: okFetch, run, env: {} });
  assert.equal(out.split('\n').length, 3);
  assert.equal(n, 3);
});
