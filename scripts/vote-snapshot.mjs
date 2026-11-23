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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Discussions in the vote category, with the first page of 👍 users each. */
export const DISCUSSIONS_QUERY = `
query Votes($owner: String!, $name: String!, $category: String, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 100, after: $after, category: $category,
                orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number
        title
        url
        body
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

/** paginate the Discussions connection; no silent partial snapshots. */
export async function fetchDiscussions({ owner, name, category, token, fetchImpl }) {
  const discussions = [];
  let after = null;
  for (;;) {
    const data = await graphql(DISCUSSIONS_QUERY, { owner, name, category, after }, { token, fetchImpl });
    const conn = data?.repository?.discussions;
    if (!conn) throw new Error(`repository ${owner}/${name} or category "${category}" not found`);
    discussions.push(...(conn.nodes ?? []));

    // A 👥 group with >100 reactors is paginated one discussion at a time.
    for (const d of conn.nodes ?? []) {
      const group = (d.reactionGroups ?? []).find((g) => g?.content === REACTION);
      let page = group?.users?.pageInfo;
      while (page?.hasNextPage && page?.endCursor) {
        const more = await graphql(REACTION_USERS_QUERY,
          { owner, name, number: d.number, after: page.endCursor }, { token, fetchImpl });
        const next = more?.repository?.discussion?.reactionGroups
          ?.find((g) => g?.content === REACTION);
        if (!next) throw new Error(`discussion #${d.number}: reaction page missing`);
        group.users.nodes.push(...(next.users?.nodes ?? []));
        page = next.users?.pageInfo;
      }
    }

    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return discussions;
}

function die(message) {
  console.error(`vote-snapshot: ${message}`);
  process.exit(1);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const token = opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const [envOwner, envName] = (process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).split('/');
  const owner = String(opts.owner || envOwner);
  const name = String(opts.name || opts.repo?.split?.('/')?.pop?.() || envName);
  const category = String(opts.category || DEFAULT_CATEGORY);
  const minAccountAgeDays = Number(opts.minAccountAgeDays ?? DEFAULT_MIN_ACCOUNT_AGE_DAYS);
  if (!Number.isFinite(minAccountAgeDays) || minAccountAgeDays < 0) die('--min-account-age-days must be a non-negative number');

  const fixturePath = opts.fixture ? resolve(String(opts.fixture)) : null;
  const out = resolve(String(opts.out || join(ROOT, 'data', 'votes.json')));

  let discussions;
  let generatedAt = new Date().toISOString();
  let source = 'discussions:reactions';

  if (fixturePath) {
    if (!existsSync(fixturePath)) die(`fixture not found: ${fixturePath}`);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    discussions = fixture.discussions;
    if (!Array.isArray(discussions)) die('fixture must contain a `discussions` array');
    if (fixture.generatedAt) generatedAt = fixture.generatedAt;
    source = `fixture:${fixturePath.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/'), '.')}`;
    console.log('vote-snapshot: FIXTURE mode — GitHub API not actually run');
  } else {
    if (!token) die('no GITHUB_TOKEN/GH_TOKEN: pass --token, or use --fixture for offline replay');
    discussions = await fetchDiscussions({ owner, name, category, token });
  }

  const snapshot = buildVotesSnapshot({
    discussions, generatedAt, minAccountAgeDays, now: generatedAt,
    repository: `${owner}/${name}`, category, source,
  });

  // Never replace a good committed snapshot with an empty/wrong-category read:
  // a category typo or a transient API hiccup must fail loudly, not zero votes.
  if (snapshot.summary.discussions === 0) {
    die(`no Discussions found in "${owner}/${name}" category "${category}" — refusing to write an empty snapshot`);
  }
  if (snapshot.summary.matchedDiscussions === 0) {
    die('no Discussion could be linked to a plugin id — check titles/bodies for `dsh-market-plugin-id:` markers');
  }

  if (!opts.dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  }

  const s = snapshot.summary;
  console.log(`vote-snapshot: ${s.matchedDiscussions}/${s.discussions} Discussions matched, `
    + `${s.countedVotes}/${s.rawReactions} 👍 counted `
    + `(duplicates ${s.duplicateVotes}, under-age ${s.underAgeVotes}, invalid ${s.invalidVotes})`);
  console.log(`vote-snapshot: generatedAt=${generatedAt} source=${source}`);
  console.log(opts.dryRun ? 'vote-snapshot: --dry-run: no file written' : `vote-snapshot: wrote ${out}`);
  return snapshot;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
