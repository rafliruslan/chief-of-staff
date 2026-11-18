import { access, chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

/**
 * Which browser the agent drives is a property of the MCP config, not of this
 * code, so the tool allowlist is derived from that file rather than hardcoded.
 *
 * The bridge runs `claude -p --strict-mcp-config`, which loads only the file it
 * is handed and ignores everything else configured. So the servers named in
 * that file are, exactly, the servers that will exist. Deriving the allowlist
 * from the same source means the two can never drift, and swapping browsers is
 * a config edit rather than a patch.
 *
 * This is what lets one codebase serve two machines: Brave over CDP on Linux
 * (`brave`, `devtools`, `browser-repl`), Aside on macOS (`aside`). A hardcoded
 * `mcp__browser` list silently leaves the agent with no browser at all on the
 * other one, because --allowedTools is a whitelist: an unlisted tool is not
 * denied loudly, it is simply never offered.
 */

/** Tools the agent gets regardless of which browser is attached. */
export const BASE_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
];

/**
 * `mcp__<server>` for every server in an MCP config object. The prefix form is
 * deliberate: it covers every tool a server exposes without this file needing
 * to track what those are.
 */
export function toolPrefixes(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `mcp__${name}`);
}

/**
 * Read the MCP config and return the full allowlist.
 *
 * A missing or unreadable config is not fatal. The agent still has Read, Bash
 * and the rest, and it will say it cannot reach the browser, which is a far
 * better failure than refusing to start: the bridge is also how you would ask
 * it what went wrong.
 */
export async function browserPrefixes(path, { read = readFile, log = console.warn } = {}) {
  try {
    const prefixes = toolPrefixes(JSON.parse(await read(path, 'utf8')));
    if (prefixes.length === 0) log(`[browser] no mcpServers in ${path}; the agent will have no browser`);
    return prefixes;
  } catch (err) {
    log(`[browser] could not read ${path} (${err.message}); the agent will have no browser`);
    return [];
  }
}

/**
 * The browser plus a set of non-browser tools. `base` is a parameter because
 * routines.mjs deliberately runs narrower than the bridge does: an unattended
 * scheduled run has no one to sanity-check a web search, so it does not get one.
 */
export async function allowedTools(path, { base = BASE_TOOLS, ...opts } = {}) {
  return [...(await browserPrefixes(path, opts)), ...base];
}

/**
 * Flags by which an MCP server declares it drives a browser over CDP.
 * Playwright spells it one way, chrome-devtools-mcp another.
 */
const CDP_FLAGS = ['--cdp-endpoint', '--browserUrl'];

/**
 * The CDP endpoint this machine's browser layer uses, or null if it has none.
 *
 * Only a CDP browser can be preflighted for wedged targets, and only a CDP
 * browser can go wedged in that way. Aside is driven through its own process
 * and exposes no port, so probing one there fails on every single run and says
 * nothing. Reading the answer out of the same config that picks the browser
 * keeps this from becoming a second thing to remember.
 *
 * Returns the URL rather than a boolean so the check probes the port actually
 * configured, instead of assuming the default.
 */
export function cdpEndpoint(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  for (const server of Object.values(servers)) {
    const args = Array.isArray(server?.args) ? server.args : [];
    for (let i = 0; i < args.length; i++) {
      if (CDP_FLAGS.includes(args[i]) && typeof args[i + 1] === 'string') return args[i + 1];
    }
  }
  return null;
}

/** Read the config and report its CDP endpoint. Unreadable config means none. */
export async function browserCdpUrl(path, { read = readFile } = {}) {
  try {
    return cdpEndpoint(JSON.parse(await read(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Tool names that run arbitrary script, whatever the browser is called.
 *
 * These were denied by their literal names, `mcp__browser__browser_run_code_unsafe`
 * and `mcp__devtools__evaluate_script`. That held exactly as long as the server
 * was called `brave`: point the same Playwright MCP at Chromium under the key
 * `chromium` and the tool becomes `mcp__chromium__browser_run_code_unsafe`,
 * which no longer matches, and a door shut deliberately reopens without a word.
 *
 * So the names are derived from the config instead of written down. Every
 * configured server contributes its own spelling of both, and the two historical
 * literals are kept whether or not those servers exist: a machine whose config
 * this cannot read must not end up with a shorter denylist than before.
 */
export const UNSAFE_SUFFIXES = ['browser_run_code_unsafe', 'evaluate_script'];

/**
 * Names that must be denied whatever the config says, including spellings this
 * project no longer uses.
 *
 * These are deliberately historical. `mcp__brave__*` is what the server was
 * called before the rename, and a machine still on the old config - the Linux
 * box, until it is migrated - exposes exactly that name. Dropping it because
 * this repo moved on would leave arbitrary script running there unblocked.
 *
 * Do not "tidy" these to the current spelling. A rename script did precisely
 * that once, rewriting the values and turning the one constant whose job is to
 * outlive a rename into a duplicate of the derived list.
 */
const LEGACY_DENIED = [
  'mcp__brave__browser_run_code_unsafe',
  'mcp__browser__browser_run_code_unsafe',
  'mcp__devtools__evaluate_script',
];

export function unsafeTools(config) {
  const names = new Set(LEGACY_DENIED);
  const servers = config?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const server of Object.keys(servers)) {
      for (const suffix of UNSAFE_SUFFIXES) names.add(`mcp__${server}__${suffix}`);
    }
  }
  return [...names];
}

/** Read the config and list every arbitrary-script tool it could expose. */
export async function deniedBrowserTools(path, { read = readFile } = {}) {
  try {
    return unsafeTools(JSON.parse(await read(path, 'utf8')));
  } catch {
    // An unreadable config must not shorten the denylist.
    return [...LEGACY_DENIED];
  }
}

/**
 * ASIDE FIRST, CDP AS THE FALLBACK.
 *
 * One config may name both browsers: Aside, and the older CDP stack (Playwright,
 * chrome-devtools, the plugin's REPL) driving a Chromium on port 9222. Handing
 * the agent both meant it picked one per turn, so a task could start in one
 * browser and go looking for its tab in the other. So exactly one is attached:
 * Aside whenever its CLI is installed, the CDP servers only when it is not.
 *
 * A machine whose config names one browser is unchanged, and the config file
 * itself is never edited. When servers are dropped, the result is written beside
 * it as `<name>.resolved.json` (mode 600: a server's env may hold a token) and
 * that is the file `claude --strict-mcp-config` is handed.
 */
const CDP_SERVER_NAMES = new Set(['browser', 'devtools', 'browser-repl', 'brave', 'chromium']);

export function isAsideServer(name, server) {
  return name === 'aside' || basename(String(server?.command || '')) === 'aside';
}

export function isCdpServer(name, server) {
  const args = Array.isArray(server?.args) ? server.args : [];
  return CDP_SERVER_NAMES.has(name) || args.some((a) => CDP_FLAGS.includes(a));
}

/** Is any Aside server's command present and executable? A bare name is looked up on PATH. */
export async function asideInstalled(config, { env = process.env, canRun = defaultCanRun } = {}) {
  const servers = Object.entries(config?.mcpServers || {}).filter(([n, s]) => isAsideServer(n, s));
  for (const [, server] of servers) {
    const cmd = String(server?.command || 'aside');
    const candidates = isAbsolute(cmd) ? [cmd] : String(env.PATH || '').split(delimiter).filter(Boolean).map((d) => join(d, cmd));
    for (const c of candidates) if (await canRun(c)) return true;
  }
  return false;
}

async function defaultCanRun(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure: which servers to keep. Returns the config to use, which browser that
 * leaves, and the names dropped.
 */
export function pickBrowser(config, hasAside) {
  const servers = config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  const names = Object.keys(servers);
  const aside = names.filter((n) => isAsideServer(n, servers[n]));
  const cdp = names.filter((n) => !aside.includes(n) && isCdpServer(n, servers[n]));
  const useAside = aside.length > 0 && hasAside;
  const dropped = useAside ? cdp : aside;
  const browser = useAside ? 'aside' : cdp.length ? 'cdp' : 'none';
  if (!dropped.length) return { config, browser, dropped };
  const kept = Object.fromEntries(names.filter((n) => !dropped.includes(n)).map((n) => [n, servers[n]]));
  return { config: { ...config, mcpServers: kept }, browser, dropped };
}

/**
 * The MCP config path to hand the agent, after choosing its browser.
 * Never throws: anything unreadable returns the original path untouched, so the
 * existing "no browser" warnings still fire where they did.
 */
export async function resolveMcpConfig(path, { read = readFile, env = process.env, canRun = defaultCanRun, log = console.warn } = {}) {
  let config;
  try {
    config = JSON.parse(await read(path, 'utf8'));
  } catch {
    return { path, browser: 'none', dropped: [] };
  }
  const picked = pickBrowser(config, await asideInstalled(config, { env, canRun }));
  if (!picked.dropped.length) return { path, browser: picked.browser, dropped: [] };
  const out = join(dirname(path), `${basename(path, '.json')}.resolved.json`);
  const text = `${JSON.stringify(picked.config, null, 2)}\n`;
  try {
    let same = false;
    try {
      same = (await read(out, 'utf8')) === text;
    } catch {
      // not written yet
    }
    if (!same) {
      // Written aside and renamed, so a bridge and a routine starting together never read half a file.
      const tmp = `${out}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, out);
    }
  } catch (err) {
    log(`[browser] could not write ${out} (${err.message}); using ${path} with every browser in it`);
    return { path, browser: 'mixed', dropped: [] };
  }
  return { path: out, browser: picked.browser, dropped: picked.dropped };
}
