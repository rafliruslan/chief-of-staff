import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * In-flight runs, so a restart does not leave a "running…" message hanging.
 *
 * The bridge posts a placeholder, runs the agent, then edits the placeholder
 * with the result. If the process dies in between, nothing ever edits it and
 * the message says "running…" forever. Observed on a real thread: a placeholder
 * from 12:38 was still hanging after a restart at 21:41.
 *
 * Recording the placeholder before the run and clearing it after means anything
 * left in this file at startup is by definition an orphan.
 */
export const DEFAULT_PENDING_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'agentic-browser',
  'pending.json',
);

export function createPendingStore({ path = DEFAULT_PENDING_PATH, now = () => Date.now() } = {}) {
  async function load() {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async function persist(data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
  }

  // One change at a time. Each is read, change, write, and up to five runs
  // add and remove at once; two that overlap both read the old file, and the
  // second write undoes the first. A lost remove is an orphan that never was:
  // 2026-10-29 22:54, a restart reported a run cut off when none was running.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  return {
    /** Record a placeholder that something is expected to edit later. */
    add: (channel, ts, extra = {}) => serial(async () => {
      const data = await load();
      data[`${channel}:${ts}`] = { channel, ts, startedAt: now(), ...extra };
      await persist(data);
    }),

    /** Clear it once the placeholder has been edited, however that turned out. */
    remove: (channel, ts) => serial(async () => {
      const data = await load();
      const key = `${channel}:${ts}`;
      if (!(key in data)) return false;
      delete data[key];
      await persist(data);
      return true;
    }),

    /**
     * Everything still recorded, and empty the file in the same step. Called
     * once at startup: anything here belongs to a process that is already gone.
     */
    takeAll: () => serial(async () => {
      const data = await load();
      const entries = Object.values(data);
      if (entries.length > 0) await persist({});
      return entries;
    }),
  };
}
