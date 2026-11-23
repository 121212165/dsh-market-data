/** Pure index builder (library form), kept separate from the CLI build-index.mjs
 *  so other milestone sessions can own the CLI without breaking M1 tests. */
import { votesByPlugin } from './vote-snapshot-lib.mjs';
import { applyGovernance, DEFAULT_DEMOTION_DAYS, DEFAULT_STALE_DAYS } from './snapshot-lib.mjs';

/**
 * @param {object} input
 * @param {object[]} input.plugins
 * @param {object[]} input.groups
 * @param {object} [input.votes]  F2 snapshot from data/votes.json. When present,
 *        its generatedAt becomes the index stamp (统一 generatedAt 同源) and
 *        each plugin gets a `votes` count.
 * @param {object} [input.snapshot]  F7 daily metrics snapshot (data/snapshots/
 *        latest.json). Supplies stars / npm downloads / deadSince; absent or
 *        malformed snapshots never demote anything (fail-safe).
 * @param {string} [input.generatedAt] explicit override (used by M1 tests).
 * @param {string|Date} [input.now] clock used for the 7-day demotion / stale
 *        rules. Defaults to generatedAt -> snapshot.generatedAt ->
 *        votes.generatedAt -> real now, so fixture replay is deterministic.
 */
export function buildIndex({
  plugins,
  groups,
  votes = null,
  snapshot = null,
  now,
  generatedAt,
  demoteDays = DEFAULT_DEMOTION_DAYS,
  staleDays = DEFAULT_STALE_DAYS,
}) {
  const sortedGroups = [...groups].sort((a, b) => {
    if (a.curator !== b.curator) return a.curator === 'editor' ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const counts = votes ? votesByPlugin(votes) : null;
  const withVotes = [...plugins]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((plugin) => counts ? { ...plugin, votes: counts.get(plugin.id) ?? 0 } : plugin);

  // F7: enrich + reorder only; no entry is ever dropped from the read contract.
  const governedPlugins = applyGovernance({
    plugins: withVotes,
    snapshot,
    now: now ?? generatedAt ?? snapshot?.generatedAt ?? votes?.generatedAt ?? new Date(),
    demoteDays,
    staleDays,
  });

  return {
    schemaVersion: 1,
    generatedAt: generatedAt ?? votes?.generatedAt ?? new Date().toISOString(),
    source: 'dsh-market-data',
    plugins: governedPlugins,
    groups: sortedGroups,
  };
}
