/** F8 tests — 刷票降权 / 权重变更可解释 / 条目明细完整. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPONENTS, FUSIONS_FILE, WEIGHTS_FILE,
  computeScores, effectiveVotes, explainScore, loadWeights, scorePlugin, withScores,
} from '../scripts/score.mjs';
import { buildIndex } from '../scripts/build-index-lib.mjs';
import { buildVotesSnapshot } from '../scripts/vote-snapshot-lib.mjs';
import { renderHtml } from '../scripts/build-site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readDir = (name) => readdirSync(join(root, 'data', name))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => readJson(join(root, 'data', name, f)));

const weights = loadWeights();
const votes = readJson(join(root, 'data', 'votes.json'));
const fixtureVotesData = readJson(join(root, 'test', 'fixtures', 'votes', 'discussions.json'));
const fixtureVotes = buildVotesSnapshot({
  discussions: fixtureVotesData.discussions,
  generatedAt: fixtureVotesData.generatedAt,
  now: fixtureVotesData.generatedAt,
});
const fusions = readJson(FUSIONS_FILE);
const plugins = readDir('plugins');
const groups = readDir('groups');
const timestamp = votes.generatedAt;
const part = (entry, key) => entry.scoreBreakdown.find((c) => c.key === key);

/* ------------------------------------------------------------------ *
 * 1. 刷票降权：重复票 / 未成年账号 / 原始 reaction 都不进入有效票
 * ------------------------------------------------------------------ */
test('刷票降权：同账号重复票与未成年账号票不计入有效票', () => {
  const now = '2026-11-23T00:00:00.000Z';
  const entry = {
    pluginId: 'dsh-plugin-quota',
    votes: 4,
    rawReactions: 9,
    voters: [
      { id: '1', login: 'alice', createdAt: '2020-01-01T00:00:00Z' },
      { id: '1', login: 'alice', createdAt: '2020-01-01T00:00:00Z' }, // 重复票
      { id: '2', login: 'baby', createdAt: '2026-11-01T00:00:00Z' },  // 账号龄不足
      { id: '3', login: 'carol', createdAt: '2021-05-01T00:00:00Z' },
    ],
    excluded: { duplicates: 0, underAge: 0, invalid: 0 },
  };

  const effective = effectiveVotes(entry, { minAccountAgeDays: 30, now });
  assert.equal(effective.count, 2);
  assert.deepEqual(effective.validVoterIds, ['1', '3']);
  assert.deepEqual(effective.excluded, { duplicates: 1, underAge: 1, invalid: 0 });

  const snapshot = { ...votes, accountAgeDaysMin: 30, entries: [entry] };
  const scored = scorePlugin({
    plugin: { id: 'dsh-plugin-quota' }, groups: [], fusions: null,
    votes: snapshot, weights, now,
  });
  const votePart = part(scored, 'validVotes');
  assert.equal(votePart.count, 2);
  assert.equal(votePart.subtotal, 2 * weights.weights.validVotes.points);
  assert.equal(votePart.rawReactions, 9, '原始 reaction 只展示、不计分');
  assert.equal(scored.score,
    weights.weights.included.points + 2 * weights.weights.validVotes.points);
});

test('刷票降权：F2 快照的有效票不是原始 reaction 总数', () => {
  const scores = computeScores({ plugins, groups, fusions, votes: fixtureVotes, weights, now: fixtureVotes.generatedAt });
  const counted = [...scores.values()]
    .reduce((sum, s) => sum + part(s, 'validVotes').count, 0);
  assert.equal(counted, fixtureVotes.summary.countedVotes);
  assert.ok(fixtureVotes.summary.rawReactions > counted, 'fixture 原始数据含被排除票');
  assert.notEqual(counted, fixtureVotes.summary.rawReactions);
  assert.equal(fixtureVotes.summary.duplicateVotes + fixtureVotes.summary.underAgeVotes > 0, true);
});

/* ------------------------------------------------------------------ *
 * 2. 权重变更可解释：权重文件是唯一真源，改文件即改分与解释
 * ------------------------------------------------------------------ */
test('权重变更可解释：改权重文件即改分项、总分与页面文案，无需改代码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f8-weights-'));
  const file = join(dir, 'score.weights.json');
  const custom = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'));
  custom.weights = {
    included: { points: 9, label: '收录·自定义' },
    grouped: { points: 0, label: '组合·不计分' },
    fused: { points: 7, label: '融合·自定义' },
    validVotes: { points: 2, label: '票·自定义' },
  };
  writeFileSync(file, JSON.stringify(custom), 'utf8');

  try {
    const changed = loadWeights(file);
    const plugin = plugins.find((p) => p.id === 'dsh-plugin-quota');
    const scored = scorePlugin({ plugin, groups, fusions, votes, weights: changed, now: timestamp });
    const original = scorePlugin({ plugin, groups, fusions, votes, weights, now: timestamp });

    assert.equal(part(scored, 'included').label, '收录·自定义');
    assert.equal(part(scored, 'grouped').label, '组合·不计分');
    assert.equal(part(scored, 'included').subtotal, 9);
    assert.equal(part(scored, 'grouped').subtotal, 0);
    assert.equal(part(scored, 'fused').subtotal, 7);
    assert.equal(part(scored, 'validVotes').subtotal, part(scored, 'validVotes').count * 2);
    assert.equal(scored.score,
      9 + 0 + 7 + 2 * part(scored, 'validVotes').count);
    assert.notEqual(scored.score, original.score, '权重变化反映在总分上');
    assert.match(explainScore(scored), /收录·自定义: 1 × 9 = 9/);

    const html = renderHtml(readJson(join(root, 'data', 'index.json')), { weights: changed });
    assert.match(html, /收录·自定义/, '页面权重说明也来自同一个文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面嵌入的权重与评分器读取的权重完全一致（防漂移）', () => {
  const html = renderHtml(readJson(join(root, 'data', 'index.json')), { weights });
  const embedded = JSON.parse(
    html.match(/<script id="score-weights" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  assert.deepEqual(embedded.weights, weights.weights);
});

/* ------------------------------------------------------------------ *
 * 3. 条目明细完整：任一条目都有 score + 四项 breakdown + 来源 id
 * ------------------------------------------------------------------ */
test('任一条目都有完整 scoreBreakdown，且每项都写来源 id', () => {
  const index = readJson(join(root, 'data', 'index.json'));
  assert.ok(index.plugins.length > 0, 'index has plugins');
  for (const plugin of index.plugins) {
    assert.equal(Number.isInteger(plugin.score), true, `${plugin.id}: score 是整数`);
    assert.equal(Array.isArray(plugin.scoreBreakdown), true, `${plugin.id}: 有 breakdown`);
    assert.deepEqual(plugin.scoreBreakdown.map((c) => c.key), COMPONENTS,
      `${plugin.id}: 四项齐全`);
    let sum = 0;
    for (const component of plugin.scoreBreakdown) {
      assert.equal(component.subtotal, component.count * component.weight,
        `${plugin.id}/${component.key}: 小计 = 数量 × 权重`);
      assert.equal(component.sources.length, component.count,
        `${plugin.id}/${component.key}: 来源数量与分项数量一致`);
      for (const source of component.sources) {
        assert.equal(typeof source.id, 'string', `${plugin.id}/${component.key}: 来源有 id`);
        assert.ok(source.id.length > 0, `${plugin.id}/${component.key}: 来源 id 非空`);
      }
      sum += component.subtotal;
    }
    assert.equal(plugin.score, sum, `${plugin.id}: 总分 = 各分项之和`);
    assert.equal(part(plugin, 'included').sources[0].id, plugin.id,
      `${plugin.id}: 收录来源指向自身`);
  }
});

test('withScores / buildIndex 串联后，被组合与被融合分项带真实的组 id / 融合 id', () => {
  const snapshot = readJson(join(root, 'data', 'snapshots', 'latest.json'));
  const built = buildIndex({ plugins, groups, votes: fixtureVotes, snapshot, now: fixtureVotes.generatedAt });
  const scored = withScores(built, { fusions, votes: fixtureVotes, weights, now: fixtureVotes.generatedAt });
  const quota = scored.plugins.find((p) => p.id === 'dsh-plugin-quota');

  assert.deepEqual(part(quota, 'grouped').sources.map((s) => s.id), ['starter-three']);
  assert.deepEqual(part(quota, 'fused').sources.map((s) => s.id), ['fuse-quota-cost-ledger']);
  assert.equal(part(quota, 'validVotes').count, fixtureVotes.entries.find((entry) => entry.pluginId === quota.id).votes);
  assert.equal(quota.score, 17);
});

test('页面可解释：每条（含降级条目）都能展开分从哪来并显示来源 id', () => {
  const index = readJson(join(root, 'data', 'index.json'));
  const html = renderHtml(index, { weights });
  assert.match(html, /贡献榜/);
  assert.match(html, /分从哪来/);
  assert.match(html, /schema\/score\.weights\.json/, '页面标注权重真源');

  for (const plugin of index.plugins) {
    const row = html.match(new RegExp(`<tr data-plugin="${plugin.id}"[^>]*>[\\s\\S]*?</tr>`));
    assert.ok(row, `${plugin.id}: 页面有对应行`);
    assert.match(row[0], /分从哪来/, `${plugin.id}: 行内可展开分从哪来`);
    for (const component of plugin.scoreBreakdown) {
      for (const source of component.sources) {
        assert.ok(row[0].includes(source.id),
          `${plugin.id}: 行内显示来源 ${source.id}`);
      }
    }
  }
});
