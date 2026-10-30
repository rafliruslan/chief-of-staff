/**
 * Finish the runs in flight before exiting.
 *
 * The bridge used to exit the moment it was told to, so whatever run was
 * going died with it, and the thread got "the bridge restarted while this was
 * running". The restart was usually for something small, a persona edit or a
 * code change, and cost a whole run.
 *
 * So when told to go, the bridge stops taking new work and waits until
 * nothing is running, then exits. "Running" is the queue's count, not the
 * child processes: a turn is in the queue from before it reads the thread
 * until after its reply is posted, and either end of that can be cut off as
 * badly as the middle. New requests that arrive meanwhile are kept for the
 * next process (see `deferred` in index.mjs), so nothing is dropped.
 *
 * How long it may wait depends on who is asking:
 *
 * - SIGHUP, or the bridge deciding to restart itself (node upgraded, socket
 *   dead): up to DRAIN_MAX_MS. Nothing outside is waiting to kill it, and
 *   launchd's KeepAlive starts the next one when it exits. This is how a
 *   restart is done on macOS: `launchctl kill SIGHUP gui/<uid>/<label>`.
 * - SIGTERM, from `kickstart -k`, `bootout` or logout: launchd sends SIGKILL
 *   after ExitTimeOut, which it caps at 60 seconds for a user agent whatever
 *   the plist says (measured 2026-10-30). So on macOS the wait is cut short
 *   of that, and the bridge still exits on its own terms and releases its
 *   lock. systemd honours TimeoutStopSec, so on Linux SIGTERM waits in full.
 *
 * Ctrl-C does not drain: in a terminal it reaches the runs as well, so there
 * is nothing left to wait for.
 */

/** Above the 15-minute run limit, with room for a reply and one retry. */
export const DRAIN_MAX_MS = 20 * 60 * 1000;
export const POLL_MS = 1000;

/** How long SIGTERM may wait before the service manager kills the bridge. */
export const termDrainMs = (platform = process.platform) => (platform === 'darwin' ? 50 * 1000 : DRAIN_MAX_MS);

export function createDrain({
  busy,
  onStart = () => {},
  pollMs = POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
}) {
  let wait = null;
  let deadline = Infinity;
  return {
    get draining() {
      return wait !== null;
    },

    /**
     * Stop taking work and wait for the runs in flight. Resolves true when
     * they all finished, false when time ran out first. A later call shares
     * the first wait, and can only bring its end closer: SIGTERM during a
     * SIGHUP drain still has to beat SIGKILL.
     */
    start(reason, { maxMs = DRAIN_MAX_MS } = {}) {
      deadline = Math.min(deadline, now() + maxMs);
      if (wait) return wait;
      wait = (async () => {
        onStart();
        const t0 = now();
        const n = busy();
        if (n === 0) return true;
        log.log?.(`[agent] ${reason}: finishing ${n} run(s) before exiting`);
        while (busy() > 0) {
          if (now() >= deadline) {
            log.warn?.(`[agent] ${reason}: ${busy()} run(s) still going after ${Math.round((now() - t0) / 1000)}s; exiting anyway`);
            return false;
          }
          await sleep(pollMs);
        }
        log.log?.(`[agent] ${reason}: runs finished after ${Math.round((now() - t0) / 1000)}s; exiting`);
        return true;
      })();
      return wait;
    },
  };
}
