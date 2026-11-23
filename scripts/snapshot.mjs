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
const DEFAULT_OUT = join(ROOT, 'data', 'snapshots');
const TIMEOUT_MS = 8000;

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
    metrics = await mapLimit(plugins, 6, async (plugin) => {
      const [repo, npm] = await Promise.all([
        fetchRepo(plugin.repo, { token }),
        plugin.npm ? fetchNpm(plugin.npm) : Promise.resolve(null),
      ]);
      // A 404 repo wins over npm numbers: the link is dead regardless of
      // whether its (orphaned) package is still downloadable.
      return {
        pluginId: plugin.id,
        repo: plugin.repo,
        status: repo.status,
        stars: repo.stars,
        weeklyDownloads: npm?.weeklyDownloads,
        error: repo.error ?? npm?.error ?? null,
      };
    });
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
