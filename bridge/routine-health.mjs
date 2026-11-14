/**
 * Two things the routine runner decides without starting a model.
 *
 * GATE. Some routines exist to watch a list that is usually empty. Hammock's
 * proactive-watch fires 90 times a day to read the Hot list in another file;
 * from 2026-11-04 to 11-14 that list was empty and 751 of 792 runs were a
 * whole Sonnet session that read one section, found nothing and stopped. A
 * routine can now name that section in its frontmatter
 * (`gate: proactive-check.md#Hot list`), and the runner skips the run while
 * the section holds no item. Deciding whether an item's window is open stays
 * with the model.
 *
 * ALERTS. A routine that cannot read a source says so in its report, then the
 * next run says it again, and nobody reads the reports. Gmail u/2 and u/3 were
 * signed out from 2026-11-09 and twenty hourly checks reported "quiet". Three
 * runs lost their Slack tools and went silent. So a routine names what it could
 * not read in a last line, `[down: gmail u/2, gmail u/3]`, and the runner keeps
 * count. After `alert_after` runs in a row (default 3), it DMs Rafli once,
 * through the bot's own token, not the model's Slack tools, since those are one
 * of the things that go missing. The same goes for a routine whose runs fail
 * outright.
 *
 * There is no "it's back" message. A run that skips its reads (out of office,
 * nothing hot) leaves the line out as well, which looks the same as a recovery.
 * The count simply starts again; if the source is still down, he hears again
 * after another `alert_after` runs, which is a reminder, not noise.
 */

export const DEFAULT_ALERT_AFTER = 3;

/** `file#Heading` from frontmatter, or null. */
export function parseGate(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const i = spec.indexOf('#');
  if (i <= 0) return null;
  return { file: spec.slice(0, i).trim(), heading: spec.slice(i + 1).trim() };
}

/**
 * The items in a section: the lines under `## <heading>` up to the next `## `
 * heading or bold paragraph, that look like `key | window | what`. The section's
 * own "Format:" line and a parenthesised "(empty; ...)" note are not items.
 * Returns null when the heading is missing, so the caller can tell "empty" from
 * "the file changed and this gate no longer points anywhere".
 */
export function sectionItems(text, heading) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const items = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line.startsWith('## ') || line.startsWith('**')) break;
    if (!line || line.startsWith('Format') || line.startsWith('(')) continue;
    if ((line.match(/\|/g) || []).length >= 2) items.push(line);
  }
  return items;
}

/**
 * Should the routine run? Fails open: a gate that cannot be read runs the
 * routine, because silently never running is the failure this file exists to
 * prevent, and a wasted run is cheap by comparison.
 */
export async function checkGate(spec, readSibling) {
  const gate = parseGate(spec);
  if (!gate) return { open: true, reason: spec ? `bad gate "${spec}", running anyway` : 'no gate' };
  let text;
  try {
    text = await readSibling(gate.file);
  } catch {
    return { open: true, reason: `gate file ${gate.file} unreadable, running anyway` };
  }
  const items = sectionItems(text, gate.heading);
  if (items === null) return { open: true, reason: `no "## ${gate.heading}" in ${gate.file}, running anyway` };
  return items.length
    ? { open: true, reason: `${items.length} item(s) in ${gate.heading}` }
    : { open: false, reason: `${gate.heading} is empty` };
}

/** Sources named in the report's last `[down: ...]` line. */
export function parseDown(text) {
  const all = [...String(text || '').matchAll(/^\s*\[down:\s*([^\]]*)\]\s*$/gim)];
  if (!all.length) return [];
  return all
    .at(-1)[1]
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'none');
}

/** The report without the `[down: ...]` line, for the log. */
export function stripDown(text) {
  return String(text || '').replace(/^\s*\[down:[^\]]*\]\s*$/gim, '').trimEnd();
}

/**
 * Fold one run into the routine's health and say what to tell Rafli.
 * Pure: returns the next health and a list of alert texts.
 *
 * health = { failRuns, sources: { [name]: { since, runs } } }
 */
export function trackHealth(prev, { name, ok, down = [], now, error = '' }, alertAfter = DEFAULT_ALERT_AFTER) {
  const n = Math.max(1, Number(alertAfter) || DEFAULT_ALERT_AFTER);
  const at = new Date(now).toISOString();
  const health = { failRuns: prev?.failRuns ?? 0, sources: { ...(prev?.sources ?? {}) } };
  const alerts = [];

  if (!ok) {
    // A failed run says nothing about its sources, so leave their counts alone.
    health.failRuns += 1;
    if (health.failRuns === n) {
      const why = String(error).split('\n')[0].slice(0, 200);
      alerts.push(`Routine \`${name}\` has failed ${n} runs in a row${why ? `: ${why}` : ''}. Nothing it watches is being checked.`);
    }
    return { health, alerts };
  }

  health.failRuns = 0;
  const next = {};
  for (const src of down) {
    const was = health.sources[src];
    const s = { since: was?.since ?? at, runs: (was?.runs ?? 0) + 1 };
    next[src] = s;
    if (s.runs === n) {
      alerts.push(`Routine \`${name}\` could not read *${src}* for ${n} runs in a row (since ${s.since.slice(0, 16).replace('T', ' ')} UTC). Its reports still say quiet, so anything there is being missed.`);
    }
  }
  health.sources = next;
  return { health, alerts };
}
