/**
 * F7 pure helpers: daily metrics snapshots, 404 dead-link tracking and
 * homepage demotion / stale marking. No I/O and no network here — the CLI
 * (snapshot.mjs) owns fetching/writing, tests own the fixtures.
 *
 * Rules (plan §7 F7 / §8 GitHub 数据滞后风险):
 *   1. only HTTP 404 means "dead"; network errors / 403 / 429 are a *fallback*
 *      (keep the last good numbers), never a false dead-link;
 *   2. `deadSince` is the FIRST day the repo was seen dead, carried forward on
 *      later snapshots, and cleared when the repo comes back (recovery path);
 *   3. a dead link is demoted when `now - deadSince >= 7` days. Demotion only
 *      reorders / hides the entry on the homepage — the entry is never deleted
 *      from index.json, so recovery is automatic;
 *   4. a missing / malformed snapshot never demotes anything (fail-safe).
 */

export const DEFAULT_DEMOTION_DAYS = 7;
export const DEFAULT_STALE_DAYS = 30;
export const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a YYYY-MM-DD calendar day (the format used by deadSince / date). */
export function validDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** UTC calendar day of any parseable date, or null. */
export function utcDay(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Milliseconds for a YYYY-MM-DD (UTC midnight) or an ISO timestamp. */
export function timeOf(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (validDay(value)) return Date.parse(`${value}T00:00:00.000Z`);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Whole days from `value` to `now`; null when the reference date is unknown. */
export function daysSince(value, now = new Date()) {
  const from = timeOf(value);
  if (from == null) return null;
  const to = timeOf(now) ?? Date.now();
  return Math.floor((to - from) / DAY_MS);
}

/** Accept metrics keyed by plugin id, keyed by repo, or an array of entries. */
export function pickMetric(metrics, plugin) {
  if (!metrics || !plugin) return null;
  if (Array.isArray(metrics)) {
    return metrics.find((m) => m?.pluginId === plugin.id || m?.repo === plugin.repo) ?? null;
  }
  if (typeof metrics !== 'object') return null;
  return metrics[plugin.id] ?? metrics[plugin.repo] ?? null;
}

/**
 * Resolve the first day a repo was seen dead. 404 keeps a prior deadSince (or
 * starts one today); any non-404 clears it — that is the recovery path.
 * A fixture may pin deadSince explicitly so the 7-day rule is replayable.
 */
export function resolveDeadSince({ status, deadSince, previous, day }) {
  if (status !== 404) return null;
  if (validDay(deadSince)) return deadSince;
  if (validDay(previous?.deadSince)) return previous.deadSince;
  return validDay(day) ? day : null;
}

/** Build the Map<pluginId, entry> used by the index builder, tolerating junk. */
export function snapshotEntryMap(snapshot) {
  const out = new Map();
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  for (const entry of entries) {
    if (entry && typeof entry.pluginId === 'string') out.set(entry.pluginId, entry);
  }
  return out;
}

/**
 * Turn raw per-plugin metrics into the committed daily snapshot contract.
 *
 * @param {object}  input
 * @param {object[]} input.plugins  one-file-per-plugin data
 * @param {object|object[]} input.metrics  raw fetch results (or fixture values)
 * @param {string} [input.day]  YYYY-MM-DD snapshot day (fixture-replayable)
 * @param {string|Date} [input.now]  snapshot timestamp
 * @param {object} [input.previous]  previous snapshot (carry-forward source)
 * @param {string} [input.source]  provenance string
 */
export function buildMetricsSnapshot({
  plugins = [],
  metrics = null,
  day,
  now = new Date(),
  previous = null,
  source = 'github:api + npm:downloads',
} = {}) {
  const date = validDay(day) ? day : (utcDay(now) ?? utcDay());
  const stamp = timeOf(now) != null
    ? (now instanceof Date ? now.toISOString() : String(now))
    : new Date().toISOString();
  const prevById = snapshotEntryMap(previous);
  const summary = { total: 0, live: 0, dead: 0, fallback: 0 };

  const entries = plugins.map((plugin) => {
    const raw = pickMetric(metrics, plugin) ?? {};
    const prev = prevById.get(plugin.id) ?? {};
    const status = Number.isInteger(raw.status) ? raw.status : 0;
    const dead = status === 404 || raw.dead === true;
    const failed = !dead && (status === 0 || status >= 400 || Boolean(raw.error));
    const deadSince = resolveDeadSince({
      status: dead ? 404 : status,
      deadSince: raw.deadSince,
      previous: prev,
      day: date,
    });

    // Last good values survive a transient fetch failure; a 404 keeps the
    // historical numbers but is no longer advertised as live.
    const stars = Number.isInteger(raw.stars) ? raw.stars : (prev.stars ?? null);
    const weeklyDownloads = Number.isInteger(raw.weeklyDownloads)
      ? raw.weeklyDownloads
      : (prev.weeklyDownloads ?? null);
    const lastSeenAt = dead || failed
      ? (prev.lastSeenAt ?? null)
      : (raw.lastSeenAt ?? date);

    summary.total++;
    if (dead) summary.dead++;
    else if (failed) summary.fallback++;
    else summary.live++;

    return {
      pluginId: plugin.id,
      repo: plugin.repo,
      npm: plugin.npm ?? null,
      status,
      live: !dead,
      stars,
      weeklyDownloads,
      deadSince,
      lastSeenAt,
      fallback: failed,
      error: raw.error ?? null,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: stamp,
    date,
    source,
    summary,
    entries,
  };
}

function withStale(plugin, reference, staleDays, now) {
  const days = daysSince(reference, now);
  if (days != null && days >= staleDays) {
    return { ...plugin, staleReason: `超过 ${staleDays} 天无更新（自 ${reference}）` };
  }
  return plugin;
}

/**
 * Enrich plugins with snapshot metrics + governance reasons and push demoted
 * entries to the end of the homepage list. Entries are NEVER removed.
 *
 * @returns {object[]} a new, ordered array of plugin objects
 */
export function applyGovernance({
  plugins = [],
  snapshot = null,
  now = new Date(),
  demoteDays = DEFAULT_DEMOTION_DAYS,
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  const byId = snapshotEntryMap(snapshot);
  const enriched = plugins.map((plugin) => {
    const entry = byId.get(plugin.id);
    if (!entry) return withStale(plugin, plugin.verifiedAt, staleDays, now);

    const next = { ...plugin };
    if (Number.isInteger(entry.stars)) next.stars = entry.stars;
    if (Number.isInteger(entry.weeklyDownloads)) next.weeklyDownloads = entry.weeklyDownloads;
    if (entry.lastSeenAt) next.lastSeenAt = entry.lastSeenAt;
    if (validDay(entry.deadSince)) next.deadSince = entry.deadSince;

    // Only a snapshot that actually observed a 404 can demote. The builder
    // clears deadSince on recovery; we still fail closed on inconsistent data
    // (e.g. a stale deadSince left next to a 200) rather than demote by mistake.
    const isDeadObservation = entry.status === 404 || entry.live === false;
    const deadDays = daysSince(entry.deadSince, now);
    if (isDeadObservation && deadDays != null && deadDays >= demoteDays) {
      next.demotionReason = `仓库 404 已持续 ${deadDays} 天（自 ${entry.deadSince}）`;
    }
    return withStale(next, entry.lastSeenAt ?? plugin.verifiedAt, staleDays, now);
  });

  // Stable partition: demoted entries stay in the data but sink to the bottom
  // of the homepage, so recovery simply moves them back up on the next build.
  return [
    ...enriched.filter((p) => !p.demotionReason),
    ...enriched.filter((p) => p.demotionReason),
  ];
}
