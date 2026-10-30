/**
 * Finish the runs in flight before exiting.
 *
 * Every restart reaches the bridge as SIGTERM: `launchctl kickstart -k`,
 * `bootout`, `systemctl restart`, restart-self once it gives up waiting. The
 * bridge used to exit on it at once, so whatever run was going died with it,
 * and the thread got "the bridge restarted while this was running". The
 * restart was usually for something small, a persona edit or a code change,
 * and cost a whole run.
 *
 * So on the first signal the bridge stops taking new work and waits until
 * nothing is running, then exits. "Running" is the queue's count, not the
 * child processes: a turn is in the queue from before it reads the thread
 * until after its reply is posted, and either end of that can be cut off as
 * badly as the middle. New requests that arrive meanwhile are kept for the
 * next process (see `deferred` in index.mjs), so nothing is dropped.
 *
 * The wait is capped below the service manager's own limit (ExitTimeOut in
 * the plist, TimeoutStopSec in the unit), so the bridge exits on its own terms
 * and gets to release its lock. Only SIGTERM drains: Ctrl-C in a terminal
 * reaches the runs as well, so there is nothing left to wait for.
 */

/** Above the 15-minute run limit, with room for a reply and one retry. */
export const DRAIN_MAX_MS = 20 * 60 * 1000;
export const POLL_MS = 1000;

export function createDrain({
  busy,
  onStart = () => {},
  maxMs = DRAIN_MAX_MS,
  pollMs = POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
}) {
  let wait = null;
  return {
    get draining() {
      return wait !== null;
    },

    /**
     * Stop taking work and wait for the runs in flight. Resolves true when
     * they all finished, false when the cap ran out first. Later calls share
     * the first wait.
     */
    start(reason) {
      if (wait) return wait;
      wait = (async () => {
        onStart();
        const t0 = now();
        const n = busy();
        if (n === 0) return true;
        log.log?.(`[agent] ${reason}: finishing ${n} run(s) before exiting`);
        while (busy() > 0) {
          if (now() - t0 >= maxMs) {
            log.warn?.(`[agent] ${reason}: ${busy()} run(s) still going after ${Math.round(maxMs / 60000)} min; exiting anyway`);
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
