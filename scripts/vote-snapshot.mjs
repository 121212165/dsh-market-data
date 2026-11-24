/**
 * F2 CLI: fetch 👍 reactions from one Discussion per plugin, apply
 * one-person-one-vote + account-age gating, write data/votes.json.
 *
 *   node scripts/vote-snapshot.mjs                       # live GraphQL (needs token)
 *   node scripts/vote-snapshot.mjs --dry-run             # fetch + report, no write
 *   node scripts/vote-snapshot.mjs --fixture test/fixtures/votes/discussions.json
 *
 * Live mode uses GITHUB_TOKEN (or GH_TOKEN). Without a token the CLI refuses
 * to run and points at fixture mode — GitHub's GraphQL API requires auth.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './lib.mjs';
import {
  buildVotesSnapshot,
  DEFAULT_CATEGORY,
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  DEFAULT_REPOSITORY,
  REACTION,
} from './vote-snapshot-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHQL_URL = 'https://api.github.com/graphql';

/** Categories are a repository connection; Discussion filtering is client-side. */
export const DISCUSSION_CATEGORIES_QUERY = `
query VoteCategories($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussionCategories(first: 100, after: $after) {
      nodes { id name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Discussions in the repository, with the category returned for local filtering. */
export const DISCUSSIONS_QUERY = `
query Votes($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 100, after: $after,
                orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number
        title
        url
        body
        category { id name }
        reactionGroups {
          content
          users(first: 100) {
            nodes { login databaseId createdAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Extra pages for a single discussion's reaction users (rarely needed). */
export const REACTION_USERS_QUERY = `
query VoteUsers($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      reactionGroups {
        content
        users(first: 100, after: $after) {
          nodes { login databaseId createdAt }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;

async function graphql(query, variables, { token, fetchImpl = fetch }) {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-market-vote-snapshot/0.1',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`GraphQL non-JSON response: ${text.slice(0, 300)}`); }
  if (json.errors?.length) throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
}

function nextPageCursor(pageInfo, label) {
  if (!pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
    throw new Error(`${label}: missing or malformed pageInfo`);
  }
  if (!pageInfo?.hasNextPage) return null;
  if (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor) {
    throw new Error(`${label}: pagination says hasNextPage but has no endCursor`);
  }
  return pageInfo.endCursor;
}

async function fetchVoteCategory({ owner, name, category, token, fetchImpl }) {
  const categories = [];
  let after = null;
  const cursors = new Set();
  for (;;) {
    const data = await graphql(DISCUSSION_CATEGORIES_QUERY, { owner, name, after }, { token, fetchImpl });
    const conn = data?.repository?.discussionCategories;
    if (!conn) throw new Error(`repository ${owner}/${name} not found or Discussion categories unavailable`);
    if (!Array.isArray(conn.nodes)) throw new Error(`repository ${owner}/${name}: malformed discussionCategories response`);
    categories.push(...conn.nodes);
    const next = nextPageCursor(conn.pageInfo, 'discussionCategories');
    if (next === null) break;
    if (cursors.has(next)) throw new Error(`discussionCategories: repeated cursor ${next}`);
    cursors.add(next);
    after = next;
  }

  const matches = categories.filter((item) => item?.name === category);
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `category "${category}" is ambiguous in ${owner}/${name}`
      : `category "${category}" not found in ${owner}/${name}`);
  }
  return matches[0];
}

/** Paginate category and Discussion connections; never return a partial snapshot. */
export async function fetchDiscussions({ owner, name, category, token, fetchImpl }) {
  const selectedCategory = await fetchVoteCategory({ owner, name, category, token, fetchImpl });
  const discussions = [];
  let after = null;
  const cursors = new Set();
  for (;;) {
    const data = await graphql(DISCUSSIONS_QUERY, { owner, name, after }, { token, fetchImpl });
    const conn = data?.repository?.discussions;
    if (!conn) throw new Error(`repository ${owner}/${name} not found or Discussions unavailable`);
    if (!Array.isArray(conn.nodes)) throw new Error(`repository ${owner}/${name}: malformed discussions response`);
    for (const discussion of conn.nodes) {
      if (!discussion || typeof discussion.category?.id !== 'string' || !discussion.category.id) {
        throw new Error('Discussion response is missing category.id; refusing a partial category snapshot');
      }
      if (!Array.isArray(discussion.reactionGroups)) {
        throw new Error(`discussion #${discussion.number ?? '?'}: malformed reactionGroups response`);
      }
    }

    // Filter by the category id obtained from the supported category connection.
    const selected = conn.nodes.filter((discussion) => discussion?.category?.id === selectedCategory.id);
    discussions.push(...selected);

    // A 👍 group with >100 reactors is paginated one discussion at a time.
    for (const d of selected) {
      const group = (d.reactionGroups ?? []).find((g) => g?.content === REACTION);
      if (!group?.users || !Array.isArray(group.users.nodes)) {
        if (group) throw new Error(`discussion #${d.number}: malformed reaction users response`);
        continue;
      }
      let page = group?.users?.pageInfo;
      const reactionCursors = new Set();
      for (;;) {
        const cursor = nextPageCursor(page, `discussion #${d.number} reaction users`);
        if (cursor === null) break;
        if (reactionCursors.has(cursor)) throw new Error(`discussion #${d.number}: repeated reaction cursor ${cursor}`);
        reactionCursors.add(cursor);
        const more = await graphql(REACTION_USERS_QUERY,
          { owner, name, number: d.number, after: cursor }, { token, fetchImpl });
        const next = more?.repository?.discussion?.reactionGroups
          ?.find((g) => g?.content === REACTION);
        if (!next || !Array.isArray(next.users?.nodes)) throw new Error(`discussion #${d.number}: reaction page missing or malformed`);
        group.users.nodes.push(...next.users.nodes);
        page = next.users?.pageInfo;
      }
    }

    const next = nextPageCursor(conn.pageInfo, 'discussions');
    if (next === null) break;
    if (cursors.has(next)) throw new Error(`discussions: repeated cursor ${next}`);
    cursors.add(next);
    after = next;
  }
  return discussions;
}

export async function runVoteSnapshot(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv);
  const token = opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const [envOwner, envName] = (process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).split('/');
  const owner = String(opts.owner || envOwner);
  const name = String(opts.name || opts.repo?.split?.('/')?.pop?.() || envName);
  const category = String(opts.category || DEFAULT_CATEGORY);
  const minAccountAgeDays = Number(opts.minAccountAgeDays ?? DEFAULT_MIN_ACCOUNT_AGE_DAYS);
  if (!Number.isFinite(minAccountAgeDays) || minAccountAgeDays < 0) throw new Error('--min-account-age-days must be a non-negative number');

  const fixturePath = opts.fixture ? resolve(String(opts.fixture)) : null;
  const out = resolve(String(opts.out || join(ROOT, 'data', 'votes.json')));

  let discussions;
  let generatedAt = new Date((deps.now ?? Date.now)()).toISOString();
  let source = 'discussions:reactions';

  if (fixturePath) {
    if (!existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    discussions = fixture.discussions;
    if (!Array.isArray(discussions)) throw new Error('fixture must contain a `discussions` array');
    if (fixture.generatedAt) generatedAt = fixture.generatedAt;
    source = `fixture:${fixturePath.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/'), '.')}`;
    (deps.log ?? console.log)('vote-snapshot: FIXTURE mode — GitHub API not actually run');
  } else {
    if (!token) throw new Error('no GITHUB_TOKEN/GH_TOKEN: pass --token, or use --fixture for offline replay');
    discussions = await fetchDiscussions({ owner, name, category, token, fetchImpl: deps.fetchImpl });
  }

  const snapshot = buildVotesSnapshot({
    discussions, generatedAt, minAccountAgeDays, now: generatedAt,
    repository: `${owner}/${name}`, category, source,
  });

  // Never replace a good committed snapshot with an empty/wrong-category read:
  // a category typo or a transient API hiccup must fail loudly, not zero votes.
  if (snapshot.summary.discussions === 0) {
    throw new Error(`no Discussions found in "${owner}/${name}" category "${category}" — refusing to write an empty snapshot`);
  }
  if (snapshot.summary.matchedDiscussions === 0) {
    throw new Error('no Discussion could be linked to a plugin id — check titles/bodies for `dsh-market-plugin-id:` markers');
  }

  if (!opts.dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    const temporary = `${out}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, out);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* preserve the original write error */ }
      throw error;
    }
  }

  const s = snapshot.summary;
  const log = deps.log ?? console.log;
  log(`vote-snapshot: ${s.matchedDiscussions}/${s.discussions} Discussions matched, `
    + `${s.countedVotes}/${s.rawReactions} 👍 counted `
    + `(duplicates ${s.duplicateVotes}, under-age ${s.underAgeVotes}, invalid ${s.invalidVotes})`);
  log(`vote-snapshot: generatedAt=${generatedAt} source=${source}`);
  log(opts.dryRun ? 'vote-snapshot: --dry-run: no file written' : `vote-snapshot: wrote ${out}`);
  return snapshot;
}

export const main = runVoteSnapshot;

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
