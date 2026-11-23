/**
 * F2 acceptance tests. Three required categories:
 *   1. 同一账号重复投票只计 1
 *   2. 未达账号龄不计
 *   3. 快照与 Discussion 数一致（含 index.json / 榜单页数据）
 * Plus a CLI replay check (fixture mode + --dry-run, no network).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildIndex } from '../scripts/build-index-lib.mjs';
import { renderHtml } from '../scripts/build-site.mjs';
import {
  accountAgeDays,
  buildVotesSnapshot,
  extractPluginId,
  filterReactionVoters,
} from '../scripts/vote-snapshot-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = join(root, 'test', 'fixtures', 'votes', 'discussions.json');
const NOW = '2026-11-23T09:00:00.000Z';

const user = (login, databaseId, createdAt = '2020-01-01T00:00:00Z') => ({ login, databaseId, createdAt });
const group = (nodes) => ({
  content: 'THUMBS_UP',
  users: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
});
const discussion = (number, pluginId, nodes, title = `Vote: ${pluginId}`) => ({
  number,
  title,
  url: `https://github.com/121212165/dsh-market-data/discussions/${number}`,
  body: `<!-- dsh-market-plugin-id: ${pluginId} -->`,
  reactionGroups: [group(nodes)],
});

/* ------------------------------------------------------------------ *
 * 1. 重复投票只计 1（一人一票）
 * ------------------------------------------------------------------ */
test('duplicate votes from the same account count once', () => {
  const reactions = [user('alice', 1001), user('alice', 1001), user('bob', 1002)];
  const snapshot = buildVotesSnapshot({
    discussions: [discussion(1, 'dsh-plugin-alpha', reactions)],
    now: NOW,
    generatedAt: NOW,
  });

  assert.equal(snapshot.entries[0].votes, 2, 'alice twice + bob once = 2 valid votes');
  assert.equal(snapshot.summary.rawReactions, 3);
  assert.equal(snapshot.summary.duplicateVotes, 1);
  assert.deepEqual(snapshot.entries[0].voters.map((v) => v.login), ['alice', 'bob']);
  assert.deepEqual(snapshot.entries[0].excluded, { duplicates: 1, underAge: 0, invalid: 0 });
});

test('dedup also works by login when databaseId is absent, and across discussions', () => {
  const a = { login: 'ALICE', createdAt: '2020-01-01T00:00:00Z' };
  const b = { login: 'alice', createdAt: '2020-01-01T00:00:00Z' };
  const snapshot = buildVotesSnapshot({
    discussions: [
      discussion(1, 'dsh-plugin-alpha', [a, b]),
      discussion(2, 'dsh-plugin-alpha', [b]),
    ],
    now: NOW,
    generatedAt: NOW,
  });
  assert.equal(snapshot.entries[0].votes, 1);
  assert.equal(snapshot.summary.duplicateVotes, 2, 'same login in 3 places collapses to 1');
});

/* ------------------------------------------------------------------ *
 * 2. 未达账号龄不计（可配置门槛）
 * ------------------------------------------------------------------ */
test('accounts younger than the threshold are excluded', () => {
  const young = user('young', 9, '2026-11-10T00:00:00Z');   // 13 days at NOW
  const old = user('old', 10, '2020-01-01T00:00:00Z');
  const noDate = { login: 'nope', databaseId: 11 };         // fails closed
  const reactions = [young, old, noDate];

  const snapshot = buildVotesSnapshot({
    discussions: [discussion(1, 'dsh-plugin-alpha', reactions)],
    now: NOW,
    generatedAt: NOW,
    minAccountAgeDays: 30,
  });
  assert.equal(snapshot.entries[0].votes, 1);
  assert.deepEqual(snapshot.entries[0].voters.map((v) => v.login), ['old']);
  assert.equal(snapshot.summary.underAgeVotes, 1);
  assert.equal(snapshot.summary.invalidVotes, 1);
  assert.equal(accountAgeDays(young, NOW), 13);

  // The same reaction is valid when the gate is explicitly lowered.
  const relaxed = buildVotesSnapshot({
    discussions: [discussion(1, 'dsh-plugin-alpha', reactions)],
    now: NOW,
    generatedAt: NOW,
    minAccountAgeDays: 7,
  });
  assert.equal(relaxed.entries[0].votes, 2, 'young account passes a 7-day gate');
  assert.equal(relaxed.accountAgeDaysMin, 7);
});

test('only 👍 reactions are counted', () => {
  const heart = {
    content: 'HEART',
    users: { nodes: [user('alice', 1001)], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const d = discussion(1, 'dsh-plugin-alpha', [user('bob', 1002)]);
  d.reactionGroups.push(heart);
  const result = filterReactionVoters(d.reactionGroups, { now: NOW });
  assert.deepEqual(result.voters.map((v) => v.login), ['bob']);
  assert.equal(result.rawReactions, 1);
});

/* ------------------------------------------------------------------ *
 * 3. 快照与 Discussion 数一致（index.json + 榜单页同源）
 * ------------------------------------------------------------------ */
test('fixture snapshot matches every Discussion and flows into index.json / page', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const pluginById = new Map(readdirSync(join(root, 'data', 'plugins'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = JSON.parse(readFileSync(join(root, 'data', 'plugins', f), 'utf8'));
      return [p.id, p];
    }));

  const snapshot = buildVotesSnapshot({
    discussions: fixture.discussions,
    generatedAt: fixture.generatedAt,
    now: fixture.generatedAt,
  });

  // one Discussion per plugin, no orphans, no silent drops
  assert.equal(snapshot.summary.discussions, fixture.discussions.length);
  assert.equal(snapshot.summary.matchedDiscussions, fixture.discussions.length);
  assert.equal(snapshot.summary.unmatchedDiscussions, 0);
  assert.equal(snapshot.entries.length, fixture.discussions.length);
  for (const entry of snapshot.entries) {
    assert.ok(pluginById.has(entry.pluginId), `unknown plugin ${entry.pluginId}`);
    assert.equal(extractPluginId({ body: `<!-- dsh-market-plugin-id: ${entry.pluginId} -->` }), entry.pluginId);
  }
  assert.equal(snapshot.summary.countedVotes, 41);
  assert.equal(snapshot.summary.duplicateVotes, 3);
  assert.equal(snapshot.summary.underAgeVotes, 7);
  assert.equal(snapshot.entries.reduce((n, e) => n + e.votes, 0), snapshot.summary.countedVotes);

  // votes and generatedAt share the snapshot as their single source
  const index = buildIndex({
    plugins: [...pluginById.values()],
    groups: [],
    votes: snapshot,
  });
  assert.equal(index.generatedAt, fixture.generatedAt);
  const votesInIndex = new Map(index.plugins.map((p) => [p.id, p.votes]));
  assert.equal(votesInIndex.get('dsh-plugin-quota'), 5);
  assert.equal(votesInIndex.get('dsh-plugin-error-radar'), 0);
  assert.equal([...votesInIndex.values()].reduce((a, b) => a + b, 0), 41);
  assert.ok(index.plugins.every((p) => Number.isInteger(p.votes)), 'every plugin carries an integer vote count');

  // the static leaderboard embeds the exact same index (no data drift)
  const html = renderHtml(index, { sourceSha256: 'f2', builtAt: index.generatedAt });
  const embeddedRaw = html.match(/<script id="market-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(embeddedRaw, 'page embeds market data');
  const embedded = JSON.parse(embeddedRaw);
  const embeddedVotes = new Map(embedded.plugins.map((p) => [p.id, p.votes]));
  for (const entry of snapshot.entries) {
    assert.equal(embeddedVotes.get(entry.pluginId), entry.votes, `page votes for ${entry.pluginId}`);
  }
  assert.match(html, /data-votes="5"/, 'leaderboard renders the vote count');
});

/* ------------------------------------------------------------------ *
 * CLI: fixture mode and --dry-run (offline, no GitHub API call)
 * ------------------------------------------------------------------ */
test('CLI fixture mode writes votes.json; --dry-run leaves no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-vote-'));
  const out = join(dir, 'votes.json');
  const script = join(root, 'scripts', 'vote-snapshot.mjs');

  const dry = execFileSync(process.execPath,
    [script, '--fixture', fixturePath, '--dry-run', '--out', out], { encoding: 'utf8' });
  assert.match(dry, /FIXTURE mode/);
  assert.match(dry, /--dry-run: no file written/);
  assert.equal(existsSync(out), false);

  execFileSync(process.execPath, [script, '--fixture', fixturePath, '--out', out], { encoding: 'utf8' });
  const snapshot = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(snapshot.summary.countedVotes, 41);
  assert.equal(snapshot.entries.length, 25);
  assert.equal(snapshot.generatedAt, '2026-11-23T09:00:00.000Z');
});
