/**
 * F2 pure helpers: turn Discussion 👍 reactions into a one-person-one-vote,
 * age-gated vote snapshot. No I/O and no network here — the CLI in
 * vote-snapshot.mjs owns fetching and writing, tests own the fixtures.
 *
 * Anti-gaming rules (plan §7 F2 / §8 刷票风险):
 *   1. one vote per account, keyed by GitHub databaseId (login fallback);
 *   2. account must be at least `minAccountAgeDays` old at snapshot time;
 *   3. only the 👍 (THUMBS_UP) reaction group is counted;
 *   4. an unparseable createdAt fails closed (excluded, never counted).
 */

export const REACTION = 'THUMBS_UP';
export const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 30;
export const DEFAULT_REPOSITORY = '121212165/dsh-market-data';
// GitHub Discussions categories are UI-managed and have no GraphQL create mutation.
// The restored repository starts with the built-in General category.
export const DEFAULT_CATEGORY = 'General';

/** Bodies carry a stable id so a renamed plugin cannot break the link. */
export const ID_MARKER_RE = /<!--\s*dsh-market-plugin-id:\s*(dsh-plugin-[a-z0-9-]+)\s*-->/i;
const ID_TOKEN_RE = /\b(dsh-plugin-[a-z0-9-]+)\b/i;

/** Resolve the plugin id a vote Discussion belongs to. Marker > title > body. */
export function extractPluginId(discussion = {}) {
  const body = String(discussion.body ?? '');
  const title = String(discussion.title ?? '');
  return ID_MARKER_RE.exec(body)?.[1]
    ?? ID_TOKEN_RE.exec(title)?.[1]
    ?? ID_TOKEN_RE.exec(body)?.[1]
    ?? null;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const t = Date.parse(now);
  return Number.isFinite(t) ? t : Date.now();
}

/** Whole days since account creation; null when createdAt is missing/invalid. */
export function accountAgeDays(user, now) {
  const created = Date.parse(user?.createdAt);
  if (!Number.isFinite(created)) return null;
  return Math.floor((toMs(now) - created) / 86400000);
}

function voterKey(user, index, seen) {
  const raw = user?.databaseId != null
    ? `id:${String(user.databaseId)}`
    : `login:${String(user?.login ?? user?.id ?? `anon-${index}`).toLowerCase()}`;
  return { key: raw, id: String(user?.databaseId ?? user?.id ?? user?.login ?? `anon-${index}`) };
}

/**
 * Filter one reaction group's users. `seen` is optional and can be shared
 * across discussions so a double-voter hitting two threads is still one vote.
 */
export function filterReactionVoters(groups, {
  minAccountAgeDays = DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  now = Date.now(),
  reaction = REACTION,
  seen = new Set(),
} = {}) {
  const all = Array.isArray(groups) ? groups : [groups];
  const target = all.find((g) => g?.content === reaction);
  const nodes = target?.users?.nodes ?? target?.users ?? [];
  const voters = [];
  let duplicated = 0;
  let underAge = 0;
  let invalid = 0;

  nodes.forEach((user, index) => {
    const { key, id } = voterKey(user, index, seen);
    if (seen.has(key)) { duplicated++; return; }
    seen.add(key);

    const age = accountAgeDays(user, now);
    if (age === null) { invalid++; return; }
    if (age < minAccountAgeDays) { underAge++; return; }

    voters.push({ id, login: String(user?.login ?? ''), createdAt: String(user?.createdAt ?? '') });
  });

  return { voters, rawReactions: nodes.length, duplicated, underAge, invalid };
}

/** Aggregate filtered reactions into one entry per plugin id. */
export function countVotes({ discussions = [], minAccountAgeDays, now, reaction = REACTION } = {}) {
  const byPlugin = new Map();
  const seenByPlugin = new Map();
  const summary = {
    discussions: discussions.length,
    matchedDiscussions: 0,
    unmatchedDiscussions: 0,
    rawReactions: 0,
    countedVotes: 0,
    duplicateVotes: 0,
    underAgeVotes: 0,
    invalidVotes: 0,
  };

  for (const discussion of discussions) {
    const pluginId = extractPluginId(discussion);
    if (!pluginId) { summary.unmatchedDiscussions++; continue; }

    if (!seenByPlugin.has(pluginId)) seenByPlugin.set(pluginId, new Set());
    const result = filterReactionVoters(discussion.reactionGroups, {
      minAccountAgeDays, now, reaction, seen: seenByPlugin.get(pluginId),
    });

    summary.matchedDiscussions++;
    summary.rawReactions += result.rawReactions;
    summary.duplicateVotes += result.duplicated;
    summary.underAgeVotes += result.underAge;
    summary.invalidVotes += result.invalid;
    summary.countedVotes += result.voters.length;

    const entry = byPlugin.get(pluginId) ?? {
      pluginId,
      discussionNumber: discussion.number ?? null,
      discussionTitle: String(discussion.title ?? ''),
      discussionUrl: String(discussion.url ?? ''),
      votes: 0,
      voters: [],
      excluded: { duplicates: 0, underAge: 0, invalid: 0 },
    };
    entry.votes += result.voters.length;
    entry.voters.push(...result.voters);
    entry.excluded.duplicates += result.duplicated;
    entry.excluded.underAge += result.underAge;
    entry.excluded.invalid += result.invalid;
    byPlugin.set(pluginId, entry);
  }

  return {
    entries: [...byPlugin.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    summary,
  };
}

/** Public snapshot contract written to data/votes.json. */
export function buildVotesSnapshot({
  discussions = [],
  generatedAt = new Date().toISOString(),
  minAccountAgeDays = DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  now = generatedAt,
  repository = DEFAULT_REPOSITORY,
  category = DEFAULT_CATEGORY,
  source = 'discussions:reactions',
} = {}) {
  const { entries, summary } = countVotes({ discussions, minAccountAgeDays, now });
  return {
    schemaVersion: 1,
    generatedAt,
    source,
    repository,
    category,
    reaction: REACTION,
    accountAgeDaysMin: minAccountAgeDays,
    summary,
    entries,
  };
}

/** Map pluginId -> counted votes, for the index builder. */
export function votesByPlugin(votes) {
  const map = new Map();
  for (const entry of votes?.entries ?? []) map.set(entry.pluginId, entry.votes);
  return map;
}
