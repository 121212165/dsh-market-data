/**
 * F2 acceptance tests. Three required categories:
 *   1. 同一账号重复投票只计 1
 *   2. 未达账号龄不计
 *   3. 快照与 Discussion 数一致（含 index.json / 榜单页数据）
 * Plus a CLI replay check (fixture mode + --dry-run, no network).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildIndex } from '../scripts/build-index-lib.mjs';
import { renderHtml } from '../scripts/build-site.mjs';
import {
  DISCUSSION_CATEGORIES_QUERY,
  DISCUSSIONS_QUERY,
  REACTION_USERS_QUERY,
  fetchDiscussions,
  runVoteSnapshot,
} from '../scripts/vote-snapshot.mjs';
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
  try {
    const dry = execFileSync(process.execPath,
      [script, '--fixture', fixturePath, '--dry-run', '--out', out], { encoding: 'utf8' });
    assert.match(dry, /FIXTURE mode/);
    assert.match(dry, /--dry-run: no file written/);
    assert.equal(existsSync(out), false);

    writeFileSync(out, '{"old-snapshot":true}\n', 'utf8');
    execFileSync(process.execPath, [script, '--fixture', fixturePath, '--out', out], { encoding: 'utf8' });
    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(snapshot.summary.countedVotes, 41);
    assert.equal(snapshot.entries.length, 25);
    assert.equal(snapshot.generatedAt, '2026-11-23T09:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const pageInfo = (hasNextPage = false, endCursor = null) => ({ hasNextPage, endCursor });

test('production GraphQL query separates category lookup from supported discussions args', async () => {
  assert.match(DISCUSSION_CATEGORIES_QUERY, /discussionCategories\(first:\s*100,\s*after:\s*\$after\)/);
  assert.match(DISCUSSIONS_QUERY, /discussions\(first:\s*100,\s*after:\s*\$after,/);
  assert.match(DISCUSSIONS_QUERY, /category\s*\{\s*id\s+name\s*\}/);
  assert.doesNotMatch(DISCUSSIONS_QUERY, /discussions\([^)]*\bcategory\s*:/);
  assert.doesNotMatch(DISCUSSIONS_QUERY, /\$category\b/);
  assert.match(REACTION_USERS_QUERY, /users\(first:\s*100,\s*after:\s*\$after\)/);
});

test('production fetch selects category by name and paginates categories, Discussions, and reaction users', async () => {
  const calls = [];
  const oldUser = user('old-user', 1234);
  const makeDiscussion = (number, categoryId, voters, reactionPage = pageInfo()) => ({
    number,
    title: `Vote: dsh-plugin-${number}`,
    url: `https://github.com/121212165/dsh-market-data/discussions/${number}`,
    body: `<!-- dsh-market-plugin-id: dsh-plugin-${number} -->`,
    category: { id: categoryId, name: categoryId === 'vote-id' ? 'Plugin Votes' : 'General' },
    reactionGroups: [{ content: 'THUMBS_UP', users: { nodes: voters, pageInfo: reactionPage } }],
  });
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    if (request.query === DISCUSSION_CATEGORIES_QUERY) {
      if (request.variables.after === null) return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'other-id', name: 'General' }], pageInfo: pageInfo(true, 'categories-next') },
      } } });
      assert.equal(request.variables.after, 'categories-next');
      return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'vote-id', name: 'Plugin Votes' }], pageInfo: pageInfo() },
      } } });
    }
    if (request.query === DISCUSSIONS_QUERY) {
      assert.deepEqual(Object.keys(request.variables).sort(), ['after', 'name', 'owner']);
      if (request.variables.after === null) return response({ data: { repository: {
        discussions: { nodes: [makeDiscussion(1, 'other-id', [])], pageInfo: pageInfo(true, 'discussions-next') },
      } } });
      assert.equal(request.variables.after, 'discussions-next');
      return response({ data: { repository: {
        discussions: { nodes: [makeDiscussion(2, 'vote-id', [oldUser], pageInfo(true, 'users-next'))], pageInfo: pageInfo() },
      } } });
    }
    assert.equal(request.query, REACTION_USERS_QUERY);
    assert.deepEqual(request.variables, { owner: '121212165', name: 'dsh-market-data', number: 2, after: 'users-next' });
    return response({ data: { repository: { discussion: { reactionGroups: [{
      content: 'THUMBS_UP', users: { nodes: [user('second-user', 1235)], pageInfo: pageInfo() },
    }] } } } });
  };

  const discussions = await fetchDiscussions({
    owner: '121212165', name: 'dsh-market-data', category: 'Plugin Votes', token: 'fixture-token', fetchImpl,
  });
  assert.deepEqual(discussions.map((item) => item.number), [2]);
  assert.deepEqual(discussions[0].reactionGroups[0].users.nodes.map((item) => item.login), ['old-user', 'second-user']);
  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(call.variables.category, undefined, 'category is never passed as a Discussions argument');
});

test('category/repository/API errors and incomplete pagination fail without replacing votes.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-vote-fail-'));
  const out = join(dir, 'votes.json');
  const original = '{"known-good":true}\n';
  writeFileSync(out, original, 'utf8');
  const failWith = async (fetchImpl, pattern) => {
    await assert.rejects(runVoteSnapshot([
      '--owner', '121212165', '--name', 'dsh-market-data', '--category', 'Plugin Votes', '--token', 'test', '--out', out,
    ], { fetchImpl, now: () => Date.parse(NOW), log() {} }), pattern);
    assert.equal(readFileSync(out, 'utf8'), original);
  };
  try {
    await failWith(async () => response({ data: { repository: {
      discussionCategories: { nodes: [{ id: 'general', name: 'General' }], pageInfo: pageInfo() },
    } } }), /category "Plugin Votes" not found/);
    await failWith(async () => response({ errors: [{ message: 'Repository not found' }] }), /GraphQL errors: Repository not found/);
    await failWith(async () => response({ data: { repository: null } }), /Discussion categories unavailable/);
    await failWith(async () => response('Not Found', 404), /GraphQL HTTP 404/);
    await failWith(async () => response({ data: { repository: {
      discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo(true, null) },
    } } }), /hasNextPage but has no endCursor/);
    await failWith(async () => response({ data: { repository: {
      discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo() },
    } } }), /Discussions unavailable/);

    await failWith(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query === DISCUSSION_CATEGORIES_QUERY) return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo() },
      } } });
      return response({ data: { repository: {
        discussions: { nodes: [{ ...discussion(4, 'dsh-plugin-four', []), category: null }], pageInfo: pageInfo() },
      } } });
    }, /missing category\.id/);

    await failWith(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query === DISCUSSION_CATEGORIES_QUERY) return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo() },
      } } });
      const malformed = discussion(5, 'dsh-plugin-five', []);
      malformed.category = { id: 'vote', name: 'Plugin Votes' };
      malformed.reactionGroups = null;
      return response({ data: { repository: { discussions: { nodes: [malformed], pageInfo: pageInfo() } } } });
    }, /malformed reactionGroups/);

    let calls = 0;
    await failWith(async (_url, init) => {
      const request = JSON.parse(init.body);
      calls++;
      if (request.query === DISCUSSION_CATEGORIES_QUERY) return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo() },
      } } });
      return response({ data: { repository: {
        discussions: { nodes: [], pageInfo: pageInfo(true, null) },
      } } });
    }, /hasNextPage but has no endCursor/);
    assert.equal(calls, 2);

    await failWith(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.query === DISCUSSION_CATEGORIES_QUERY) return response({ data: { repository: {
        discussionCategories: { nodes: [{ id: 'vote', name: 'Plugin Votes' }], pageInfo: pageInfo() },
      } } });
      const incomplete = discussion(9, 'dsh-plugin-nine', [user('voter', 9)]);
      incomplete.category = { id: 'vote', name: 'Plugin Votes' };
      incomplete.reactionGroups[0].users.pageInfo = pageInfo(true, null);
      return response({ data: { repository: {
        discussions: { nodes: [incomplete], pageInfo: pageInfo() },
      } } });
    }, /hasNextPage but has no endCursor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
