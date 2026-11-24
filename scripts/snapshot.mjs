/**
 * F7 CLI: daily GitHub stars / npm weekly-download snapshot.
 *
 *   node scripts/snapshot.mjs                          # live APIs (GitHub + npm)
 *   node scripts/snapshot.mjs --dry-run                # fetch + report, no write
 *   node scripts/snapshot.mjs --fixture <file>         # offline replay, no network
 *   node scripts/snapshot.mjs --date 2026-11-16 --out <dir>
 *
 * Writes <out>/<YYYY-MM-DD>.json plus <out>/latest.json (identical bytes), so
 * build-index.mjs has a stable path to consume. Live mode degrades gracefully:
 * 404 records `deadSince`, while timeouts / 403 / 429 keep the last good
 * numbers as `fallback` and never masquerade as a dead link.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mapLimit, parseArgs } from './lib.mjs';
import { buildMetricsSnapshot, utcDay } from './snapshot-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_API = 'https://api.github.com';
const NPM_DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
export const DEFAULT_ECO_SCAN_URL = 'https://raw.githubusercontent.com/121212165/dsh-plugin-eco-scan/main/data/eco-data.json';
export const DEFAULT_ECO_SCAN_MIRROR_URL = 'https://cdn.jsdelivr.net/gh/121212165/dsh-plugin-eco-scan@main/data/eco-data.json';
const DEFAULT_OUT = join(ROOT, 'data', 'snapshots');
const TIMEOUT_MS = 8000;
const ECO_SCAN_TIMEOUT_MS = 12000;

async function getJson(url, { headers = {}, signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'dsh-market-snapshot/0.1', ...headers },
    signal,
    redirect: 'follow',
  });
  if (res.status === 404) return { status: 404, json: null };
  if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };
  try {
    return { status: res.status, json: await res.json() };
  } catch (err) {
    return { status: res.status, error: `non-JSON response: ${err.message}` };
  }
}

function withTimeout(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

/** GitHub repo metadata. 404 => dead link; anything else is a soft failure. */
export async function fetchRepo(slug, { token = '', fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await getJson(`${GITHUB_API}/repos/${slug}`, { headers, signal, fetchImpl });
    if (res.status === 404 || res.error) return res;
    const stars = res.json?.stargazers_count;
    return { status: res.status, stars: Number.isInteger(stars) ? stars : null };
  } catch (err) {
    return { status: 0, error: err.message };
  } finally {
    clear();
  }
}

/** npm last-week downloads for a (possibly scoped) package name. */
export async function fetchNpm(pkg, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!pkg) return null;
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const encoded = String(pkg).replace('/', '%2F');
    const res = await getJson(`${NPM_DOWNLOADS}/${encoded}`, { signal, fetchImpl });
    if (res.error) return res;
    const downloads = res.json?.downloads;
    return { status: res.status, weeklyDownloads: Number.isInteger(downloads) ? downloads : null };
  } catch (err) {
    return { status: 0, error: err.message };
  } finally {
    clear();
  }
}

function metricValue(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Map eco-scan's `{meta, rows}` tuple export to repo -> F7 metrics. */
export function parseEcoScanMetrics(payload, plugins = []) {
  if (!payload || typeof payload !== 'object' || !payload.meta || !Array.isArray(payload.meta.columns) || !Array.isArray(payload.rows)) {
    throw new Error('eco-scan payload must contain meta.columns and rows arrays');
  }
  if (typeof payload.meta.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.meta.date)
    || !Number.isFinite(Date.parse(`${payload.meta.date}T00:00:00.000Z`))) {
    throw new Error('eco-scan meta.date must be YYYY-MM-DD');
  }
  const column = new Map(payload.meta.columns
    .filter((item) => item && typeof item.field === 'string' && Number.isInteger(item.index) && item.index >= 0)
    .map((item) => [item.field, item.index]));
  for (const field of ['id', 'stars', 'weekly']) {
    if (!column.has(field)) throw new Error(`eco-scan meta.columns missing required field: ${field}`);
  }

  const wanted = new Set(plugins.map((plugin) => String(plugin.repo ?? '').toLowerCase()).filter(Boolean));
  const byRepo = new Map();
  const ambiguous = new Set();
  for (const row of payload.rows) {
    if (!Array.isArray(row)) continue;
    const repo = row[column.get('id')];
    if (typeof repo !== 'string' || !wanted.has(repo.toLowerCase()) || ambiguous.has(repo.toLowerCase())) continue;
    const key = repo.toLowerCase();
    if (byRepo.has(key)) {
      byRepo.delete(key);
      ambiguous.add(key);
      continue;
    }
    byRepo.set(key, {
      repo,
      stars: metricValue(row[column.get('stars')]),
      weeklyDownloads: metricValue(row[column.get('weekly')]),
      lastSeenAt: payload.meta.date,
    });
  }
  return { date: payload.meta.date, byRepo, ambiguous: [...ambiguous] };
}

/** Fetch the public eco-scan export (raw first, jsDelivr mirror on failure). */
export async function fetchEcoScanMetrics({
  plugins = [],
  url = DEFAULT_ECO_SCAN_URL,
  mirrorUrl = url === DEFAULT_ECO_SCAN_URL ? DEFAULT_ECO_SCAN_MIRROR_URL : '',
  fetchImpl = fetch,
  timeoutMs = ECO_SCAN_TIMEOUT_MS,
} = {}) {
  const failures = [];
  const sources = [...new Set([url, mirrorUrl].filter(Boolean))];
  for (const source of sources) {
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const response = await getJson(source, { headers: { Accept: 'application/json' }, signal, fetchImpl });
      if (response.error || !response.json) {
        failures.push(`${source}: ${response.error ?? `HTTP ${response.status}`}`);
        continue;
      }
      const parsed = parseEcoScanMetrics(response.json, plugins);
      return { ok: true, source, ...parsed };
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clear();
    }
  }
  return { ok: false, error: failures.join(' | ') || 'no eco-scan URLs configured', date: null, byRepo: new Map(), ambiguous: [] };
}

/**
 * The eco-scan database is the preferred source for stars/npm weekly metrics.
 * GitHub API remains authoritative for repository reachability/404, and live
 * APIs fill metrics that are absent from the catalog-relevant eco-scan rows.
 */
export async function collectLiveMetrics({
  plugins = [],
  token = '',
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  ecoScanTimeoutMs = ECO_SCAN_TIMEOUT_MS,
  ecoScanUrl = DEFAULT_ECO_SCAN_URL,
  ecoScanMirrorUrl = ecoScanUrl === DEFAULT_ECO_SCAN_URL ? DEFAULT_ECO_SCAN_MIRROR_URL : '',
  observedAt = new Date().toISOString(),
} = {}) {
  const eco = await fetchEcoScanMetrics({ plugins, url: ecoScanUrl, mirrorUrl: ecoScanMirrorUrl, fetchImpl, timeoutMs: ecoScanTimeoutMs });
  const rows = await mapLimit(plugins, 6, async (plugin) => {
    const ecoMetric = eco.ok ? eco.byRepo.get(String(plugin.repo).toLowerCase()) : null;
    const hasEcoStars = Number.isInteger(ecoMetric?.stars);
    const hasEcoDownloads = Boolean(plugin.npm) && Number.isInteger(ecoMetric?.weeklyDownloads);
    const needsNpmApi = Boolean(plugin.npm) && !hasEcoDownloads;
    const [repo, npm] = await Promise.all([
      fetchRepo(plugin.repo, { token, fetchImpl, timeoutMs }),
      needsNpmApi ? fetchNpm(plugin.npm, { fetchImpl, timeoutMs }) : Promise.resolve(null),
    ]);
    const useEco = hasEcoStars || hasEcoDownloads;
    const errors = [repo.error, npm?.error].filter(Boolean);
    return {
      pluginId: plugin.id,
      repo: plugin.repo,
      status: repo.status,
      stars: hasEcoStars ? ecoMetric.stars : metricValue(repo.stars),
      weeklyDownloads: hasEcoDownloads ? ecoMetric.weeklyDownloads : metricValue(npm?.weeklyDownloads),
      ...(useEco ? { lastSeenAt: eco.date } : (repo.status === 200 ? { lastSeenAt: observedAt.slice(0, 10) } : {})),
      error: errors.length ? errors.join('; ') : null,
    };
  });
  const source = eco.ok
    ? `eco-scan:${eco.date} (${new URL(eco.source).hostname}) preferred stars/npm weekly + github:api (404 reachability) + npm:downloads (missing eco fields)`
    : 'github:api + npm:downloads (eco-scan unavailable; live fallback)';
  return {
    metrics: rows,
    source,
    ecoScan: { ok: eco.ok, date: eco.date, matched: eco.byRepo.size, ambiguous: eco.ambiguous, error: eco.error ?? null },
  };
}

/** Load the previous daily snapshot without ever throwing on missing/corrupt data. */
export function readSnapshot(file) {
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return null;
    return data;
  } catch (err) {
    console.warn(`snapshot: ignoring unreadable snapshot ${file}: ${err.message}`);
    return null;
  }
}

function loadPlugins(root) {
  const dir = join(root, 'data', 'plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
}

function die(message) {
  console.error(`snapshot: ${message}`);
  process.exit(1);
}

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const outDir = resolve(String(opts.out || DEFAULT_OUT));
  const fixturePath = opts.fixture ? resolve(String(opts.fixture)) : null;
  const previous = readSnapshot(join(outDir, 'latest.json'));
  const plugins = loadPlugins(ROOT);

  let metrics;
  let day = validDay(opts.date) ? opts.date : utcDay();
  let stamp = typeof opts.now === 'string' && opts.now ? opts.now : new Date().toISOString();
  let source = 'github:api + npm:downloads';

  if (fixturePath) {
    if (!existsSync(fixturePath)) die(`fixture not found: ${fixturePath}`);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    metrics = fixture.metrics ?? fixture.entries ?? null;
    if (!metrics) die('fixture must contain a `metrics` (or `entries`) object/array');
    if (fixture.generatedAt) stamp = fixture.generatedAt;
    day = validDay(fixture.date) ? fixture.date : (validDay(opts.date) ? opts.date : stamp.slice(0, 10));
    source = `fixture:${fixturePath.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/'), '.')}`;
    console.log('snapshot: FIXTURE mode — GitHub / npm APIs not actually called');
  } else {
    const token = String(opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '');
    const live = await collectLiveMetrics({
      plugins,
      token,
      ecoScanUrl: String(opts.ecoScanUrl || process.env.ECO_SCAN_URL || DEFAULT_ECO_SCAN_URL),
      ecoScanMirrorUrl: String(opts.ecoScanMirrorUrl || process.env.ECO_SCAN_MIRROR_URL
        || (opts.ecoScanUrl || process.env.ECO_SCAN_URL ? '' : DEFAULT_ECO_SCAN_MIRROR_URL)),
      observedAt: stamp,
    });
    metrics = live.metrics;
    source = live.source;
    if (live.ecoScan.ok) {
      console.log(`snapshot: eco-scan connected (${live.ecoScan.matched}/${plugins.length} catalog repos matched, date=${live.ecoScan.date})`);
      if (live.ecoScan.ambiguous.length) console.warn(`snapshot: ambiguous eco-scan repo rows ignored: ${live.ecoScan.ambiguous.join(', ')}`);
    } else {
      console.warn(`snapshot: eco-scan unavailable (${live.ecoScan.error}); using live GitHub/npm APIs`);
    }
  }

  const snapshot = buildMetricsSnapshot({ plugins, metrics, day, now: stamp, previous, source });
  const json = JSON.stringify(snapshot, null, 2) + '\n';

  if (!opts.dryRun) {
    mkdirSync(outDir, { recursive: true });
    const dated = join(outDir, `${snapshot.date}.json`);
    const latest = join(outDir, 'latest.json');
    writeFileSync(dated, json, 'utf8');
    writeFileSync(latest, json, 'utf8');
    console.log(`snapshot: wrote ${dated} and ${latest}`);
  } else {
    console.log('snapshot: --dry-run: no file written');
  }

  const s = snapshot.summary;
  console.log(`snapshot: ${s.total} plugins — ${s.live} live, ${s.dead} dead, ${s.fallback} fallback`
    + ` (date=${snapshot.date}, generatedAt=${snapshot.generatedAt})`);
  return snapshot;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
