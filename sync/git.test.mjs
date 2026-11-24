import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git.mjs';

test('a remote that never answers times out and says so', () => {
  const before = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'sleep 20; :';
  try {
    const start = Date.now();
    const r = git(['ls-remote', 'git@example.invalid:x/y.git'], { timeout: 1000 });
    assert.ok(Date.now() - start < 10_000, 'it returned without waiting for the remote');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /git ls-remote timed out after 1s/);
  } finally {
    if (before === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = before;
  }
});
