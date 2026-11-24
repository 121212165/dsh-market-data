/**
 * F7 acceptance tests (全部离线，无 GitHub / npm 网络请求):
 *   1. 404 仓在 deadSince 第 7 天自动从首页降级并标注原因（不删除、可恢复）；
 *   2. 快照缺失 / 损坏不崩，也不误伤条目；
 *   3. 抓取失败降级为「沿用上次好值」，不误判死链；
 *   4. 陈旧标记 + 页面徽标；
 *   5. fixture CLI 可回放（含 dry-run）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildIndex } from '../scripts/build-index-lib.mjs';
import { renderHtml } from '../scripts/build-site.mjs';
import {
  applyGovernance,
  buildMetricsSnapshot,
  resolveDeadSince,
} from '../scripts/snapshot-lib.mjs';
import {
  collectLiveMetrics,
  fetchNpm,
  fetchEcoScanMetrics,
  fetchRepo,
  parseEcoScanMetrics,
  readSnapshot,
} from '../scripts/snapshot.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = join(root, 'test', 'fixtures', 'snapshots', 'metrics.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const DEAD = 'dsh-plugin-local-deep-search';
const LIVE = 'dsh-plugin-quota';
const DAY0 = '2026-11-09';          // fixture 中 404 仓的 deadSince
const DAY6 = '2026-11-15T12:00:00.000Z';
const DAY7 = '2026-11-16T00:00:00.000Z';

const plugin = (id, extra = {}) => ({
  id,
  repo: `121212165/${id}`,
  name: id,
  oneLiner: 'fixture plugin',
  category: '工具与质量',
  entries: ['/x'],
  requires: [],
  dshRange: '*',
  license: 'MIT',
  author: '121212165',
  borrowedFrom: [],
  verifiedAt: '2026-11-21',
  ...extra,
});

const snapshotWith = (entries, date = '2026-11-16') => ({
  schemaVersion: 1,
  generatedAt: `${date}T00:00:00.000Z`,
  date,
  source: 'fixture:test',
  entries,
});

function demotionFixture() {
  return snapshotWith([
    { pluginId: LIVE, status: 200, live: true, stars: 145, weeklyDownloads: 312, lastSeenAt: '2026-11-16' },
    { pluginId: DEAD, status: 404, live: false, stars: 12, weeklyDownloads: null, deadSince: DAY0, lastSeenAt: '2026-11-08' },
  ]);
}

const indexFor = (now, snapshot = demotionFixture()) => buildIndex({
  plugins: [plugin(LIVE), plugin(DEAD)],
  groups: [],
  snapshot,
  now,
});

/* ------------------------------------------------------------------ *
 * 1. 404 → 7 天降级（验收证据）
 * ------------------------------------------------------------------ */
test('404 repo is demoted on day 7, not day 6, with a visible reason', () => {
  const at6 = indexFor(DAY6);
  assert.equal(at6.plugins.find((p) => p.id === DEAD).demotionReason, undefined,
    'day 6 must not be demoted yet');

  const at7 = indexFor(DAY7);
  const dead = at7.plugins.find((p) => p.id === DEAD);
  assert.match(dead.demotionReason, /404/, 'reason names the cause');
  assert.match(dead.demotionReason, /7 天/, 'reason names the 7-day rule');
  assert.match(dead.demotionReason, /2026-11-09/, 'reason names deadSince');
  assert.equal(dead.deadSince, DAY0);
  assert.equal(dead.stars, 12, 'last known metrics stay on the entry');
  assert.equal(at7.plugins.length, 2, 'no entry is deleted');
  assert.equal(at7.plugins.at(-1).id, DEAD, 'demoted entry sinks to the bottom of the homepage');
});

test('build-index only reorders: applyGovernance is stable for the rest', () => {
  const ids = ['dsh-plugin-a', DEAD, 'dsh-plugin-b'].map((id) => plugin(id));
  const snapshot = snapshotWith([
    { pluginId: DEAD, status: 404, deadSince: DAY0, stars: 1 },
  ]);
  const out = applyGovernance({ plugins: ids, snapshot, now: DAY7 });
  assert.deepEqual(out.map((p) => p.id), ['dsh-plugin-a', 'dsh-plugin-b', DEAD]);
  assert.equal(new Set(out.map((p) => p.id)).size, 3);
});

/* ------------------------------------------------------------------ *
 * 2. 快照缺失 / 损坏不崩
 * ------------------------------------------------------------------ */
test('missing or malformed snapshot never throws or demotes', () => {
  const noSnapshot = indexFor(DAY7, null);
  assert.equal(noSnapshot.plugins.some((p) => p.demotionReason), false);
  assert.equal(noSnapshot.plugins.length, 2);

  const malformed = indexFor(DAY7, { entries: 'not-an-array' });
  assert.equal(malformed.plugins.some((p) => p.demotionReason), false);

  const dir = mkdtempSync(join(tmpdir(), 'f7-missing-'));
  assert.equal(readSnapshot(join(dir, 'none.json')), null, 'missing file -> null');
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  assert.equal(readSnapshot(bad), null, 'corrupt file -> null, no throw');
});

/* ------------------------------------------------------------------ *
 * 3. 失败降级 & 恢复路径
 * ------------------------------------------------------------------ */
test('fetch failure keeps last good numbers and is not a dead link', () => {
  const previous = snapshotWith([
    { pluginId: 'dsh-plugin-eco-scan', status: 200, live: true, stars: 9, weeklyDownloads: 50, lastSeenAt: '2026-11-15' },
  ]);
  const snap = buildMetricsSnapshot({
    plugins: [plugin('dsh-plugin-eco-scan')],
    metrics: { 'dsh-plugin-eco-scan': { status: 0, error: 'ETIMEDOUT' } },
    day: '2026-11-16',
    now: '2026-11-16T02:00:00.000Z',
    previous,
  });
  assert.equal(snap.summary.fallback, 1);
  assert.equal(snap.summary.dead, 0);
  assert.equal(snap.entries[0].stars, 9, 'last good stars carried forward');
  assert.equal(snap.entries[0].weeklyDownloads, 50);
  assert.equal(snap.entries[0].deadSince, null, 'timeout is NOT a 404');
});

test('deadSince is carried forward while dead and cleared on recovery', () => {
  assert.equal(resolveDeadSince({ status: 404, previous: { deadSince: DAY0 }, day: '2026-11-16' }), DAY0,
    'keep the first day seen dead');
  assert.equal(resolveDeadSince({ status: 404, previous: null, day: '2026-11-16' }), '2026-11-16',
    'start a new deadSince when first seen dead');
  assert.equal(resolveDeadSince({ status: 200, previous: { deadSince: DAY0 }, day: '2026-11-16' }), null,
    'repo coming back clears deadSince (recovery path)');

  const recovered = indexFor(DAY7, snapshotWith([
    { pluginId: DEAD, status: 200, live: true, stars: 13, lastSeenAt: '2026-11-16' },
  ]));
  const entry = recovered.plugins.find((p) => p.id === DEAD);
  assert.equal(entry.demotionReason, undefined, 'recovered repo returns to the main list');
  assert.equal(entry.deadSince, undefined);
});

test('only HTTP 404 is classified as a dead repo (injected fetch, no network)', async () => {
  const fakeFetch = async (url) => {
    if (url.startsWith('https://api.github.com/repos/')) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => ({ downloads: 42 }) };
  };
  const repo = await fetchRepo('owner/gone', { fetchImpl: fakeFetch });
  assert.equal(repo.status, 404, '404 -> dead');
  const npm = await fetchNpm('@scope/pkg', { fetchImpl: fakeFetch });
  assert.equal(npm.weeklyDownloads, 42, 'npm weekly downloads parsed');
});

/* ------------------------------------------------------------------ *
 * eco-scan database integration: preferred metrics, market catalog stays local
 * ------------------------------------------------------------------ */
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function ecoPayload() {
  return {
    meta: {
      date: '2026-11-20',
      // Intentionally reordered to ensure mapping is driven by metadata.
      columns: [
        { index: 2, field: 'id' },
        { index: 0, field: 'stars' },
        { index: 1, field: 'weekly' },
      ],
    },
    rows: [
      [321, 44, 'owner/cached'],
      [1, 2, 'other/not-in-market'],
    ],
  };
}

test('eco-scan export maps by repo and supplies metrics while GitHub API still determines 404', async () => {
  const plugins = [
    { id: 'dsh-plugin-cached', repo: 'owner/cached', npm: '@scope/cached' },
    { id: 'dsh-plugin-live', repo: 'owner/live', npm: '@scope/live' },
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/data/eco-data.json')) return jsonResponse(ecoPayload());
    if (String(url) === 'https://api.github.com/repos/owner/cached') return new Response(null, { status: 404 });
    if (String(url) === 'https://api.github.com/repos/owner/live') return jsonResponse({ stargazers_count: 8 });
    if (String(url).includes('api.npmjs.org/downloads/point/last-week/')) return jsonResponse({ downloads: 15 });
    throw new Error(`unexpected URL ${url}`);
  };

  const collected = await collectLiveMetrics({
    plugins, fetchImpl, token: 'test-token', observedAt: '2026-11-24T12:00:00.000Z',
  });
  assert.equal(collected.ecoScan.ok, true);
  assert.equal(collected.ecoScan.date, '2026-11-20');
  assert.equal(collected.ecoScan.matched, 1);
  assert.match(collected.source, /eco-scan:2026-11-20/);
  assert.deepEqual(collected.metrics[0], {
    pluginId: 'dsh-plugin-cached', repo: 'owner/cached', status: 404,
    stars: 321, weeklyDownloads: 44, lastSeenAt: '2026-11-20', error: null,
  });
  assert.equal(collected.metrics[1].status, 200);
  assert.equal(collected.metrics[1].stars, 8, 'live GitHub values fill/override absent eco rows');
  assert.equal(collected.metrics[1].weeklyDownloads, 15, 'live npm API fills plugins absent from eco export');
  assert.equal(collected.metrics[1].lastSeenAt, '2026-11-24');
  assert.equal(calls.filter((url) => url.includes('api.npmjs.org')).length, 1,
    'eco metrics avoid duplicate npm API requests; unmatched plugin still falls back live');

  const snapshot = buildMetricsSnapshot({
    plugins, metrics: collected.metrics, day: '2026-11-24', now: '2026-11-24T12:00:00.000Z', source: collected.source,
  });
  assert.equal(snapshot.entries[0].status, 404);
  assert.equal(snapshot.entries[0].deadSince, '2026-11-24', 'eco metrics do not hide a live GitHub 404');
  assert.equal(snapshot.entries[0].stars, 321);
  assert.equal(snapshot.entries[0].weeklyDownloads, 44);
});

test('malformed or duplicate eco rows fail closed for that source and direct APIs remain usable', async () => {
  const plugin = { id: 'dsh-plugin-cached', repo: 'owner/cached', npm: '@scope/cached' };
  const parsed = parseEcoScanMetrics({
    ...ecoPayload(),
    rows: [[321, 44, 'owner/cached'], [999, 88, 'OWNER/CACHED']],
  }, [plugin]);
  assert.deepEqual(parsed.ambiguous, ['owner/cached']);
  assert.equal(parsed.byRepo.has('owner/cached'), false, 'ambiguous duplicate rows are not guessed');
  assert.throws(() => parseEcoScanMetrics({ meta: { date: '2026-11-20', columns: [] }, rows: [] }, [plugin]), /missing required field/);

  const collected = await collectLiveMetrics({
    plugins: [plugin],
    fetchImpl: async (url) => {
      if (String(url).includes('/data/eco-data.json')) return new Response('temporarily unavailable', { status: 503 });
      if (String(url) === 'https://api.github.com/repos/owner/cached') return jsonResponse({ stargazers_count: 12 });
      if (String(url).includes('api.npmjs.org')) return jsonResponse({ downloads: 34 });
      throw new Error(`unexpected URL ${url}`);
    },
    observedAt: '2026-11-24T12:00:00.000Z',
  });
  assert.equal(collected.ecoScan.ok, false);
  assert.match(collected.source, /eco-scan unavailable; live fallback/);
  assert.equal(collected.metrics[0].stars, 12);
  assert.equal(collected.metrics[0].weeklyDownloads, 34);
});

test('eco-scan raw timeout/error falls back to the configured CDN mirror', async () => {
  const plugins = [{ id: 'dsh-plugin-cached', repo: 'owner/cached', npm: '@scope/cached' }];
  const calls = [];
  const result = await fetchEcoScanMetrics({
    plugins,
    url: 'https://raw.example/eco-data.json',
    mirrorUrl: 'https://cdn.example/eco-data.json',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://raw.example/')) return new Response('temporarily unavailable', { status: 503 });
      return jsonResponse(ecoPayload());
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'https://cdn.example/eco-data.json');
  assert.equal(result.byRepo.get('owner/cached').stars, 321);
  assert.deepEqual(calls, ['https://raw.example/eco-data.json', 'https://cdn.example/eco-data.json']);
});

/* ------------------------------------------------------------------ *
 * 4. 页面：主列表剔除失效条目 + 单独区块标注原因 + 陈旧徽标
 * ------------------------------------------------------------------ */
test('page hides the demoted entry from the main list and prints the reason', () => {
  const html = renderHtml(indexFor(DAY7), { sourceSha256: 'f7', builtAt: DAY7 });
  assert.match(html, /id="demoted-plugins"/, 'a dedicated demoted section exists');
  assert.match(html, /data-demoted="true"/, 'demoted row is marked');
  assert.match(html, /2026-11-09/, 'the demotion reason (deadSince) is visible on the page');
  assert.match(html, /data-demoted="1"/, 'governance summary counts the demoted entry');
  assert.doesNotMatch(html, new RegExp(`<tr data-plugin="${DEAD}">`),
    '失效条目不出现在首页主列表');
  assert.match(html, /<tr data-plugin="dsh-plugin-quota">/, 'healthy entry stays in the main list');

  const embedded = JSON.parse(html.match(/<script id="market-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.plugins.length, 2, 'the entry is still in the embedded data contract');
});

test('stale entries get a badge (N days without an update)', () => {
  const snapshot = snapshotWith([
    { pluginId: LIVE, status: 200, live: true, stars: 5, weeklyDownloads: 1, lastSeenAt: '2026-09-01' },
  ]);
  const index = buildIndex({
    plugins: [plugin(LIVE)], groups: [], snapshot, now: DAY7, staleDays: 30,
  });
  assert.match(index.plugins[0].staleReason, /30 天/);
  const html = renderHtml(index, { sourceSha256: 'f7', builtAt: DAY7 });
  assert.match(html, /badge stale/, '陈旧徽标 rendered');
  assert.match(html, /data-stale="1"/);
});

/* ------------------------------------------------------------------ *
 * 5. fixture CLI 回放
 * ------------------------------------------------------------------ */
test('snapshot CLI: fixture mode writes dated + latest snapshots, --dry-run writes nothing', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'f7-snapshot-')), 'snapshots');
  const latest = join(out, 'latest.json');
  const script = join(root, 'scripts', 'snapshot.mjs');

  const dry = execFileSync(process.execPath,
    [script, '--fixture', fixturePath, '--dry-run', '--out', out], { encoding: 'utf8', cwd: root });
  assert.match(dry, /FIXTURE mode/);
  assert.match(dry, /--dry-run: no file written/);
  assert.equal(existsSync(latest), false);

  const run = execFileSync(process.execPath,
    [script, '--fixture', fixturePath, '--out', out], { encoding: 'utf8', cwd: root });
  assert.match(run, /1 dead/, 'fixture 404 is counted as dead');
  const snap = JSON.parse(readFileSync(latest, 'utf8'));
  assert.equal(snap.date, fixture.date);
  assert.equal(snap.generatedAt, fixture.generatedAt);
  const dead = snap.entries.find((e) => e.pluginId === DEAD);
  assert.equal(dead.deadSince, DAY0, 'fixture-pinned deadSince is replayable (no real 7-day wait)');
  assert.equal(dead.live, false);
  assert.equal(dead.stars, 12);
  const flaky = snap.entries.find((e) => e.pluginId === 'dsh-plugin-eco-scan');
  assert.equal(flaky.fallback, true);
  assert.equal(flaky.deadSince, null);
  assert.ok(existsSync(join(out, `${fixture.date}.json`)), 'dated snapshot written');
});
