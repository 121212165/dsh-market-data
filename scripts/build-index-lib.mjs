/** Pure index builder (library form), kept separate from the CLI build-index.mjs
 *  so other milestone sessions can own the CLI without breaking M1 tests. */
import { votesByPlugin } from './vote-snapshot-lib.mjs';

/**
 * @param {object} input
 * @param {object[]} input.plugins
 * @param {object[]} input.groups
 * @param {object} [input.votes]  F2 snapshot from data/votes.json. When present,
 *        its generatedAt becomes the index stamp (票数与 generatedAt 同源) and
 *        each plugin gets a `votes` count.
 * @param {string} [input.generatedAt] explicit override (used by M1 tests).
 */
export function buildIndex({ plugins, groups, votes = null, generatedAt }) {
  const sortedGroups = [...groups].sort((a, b) => {
    if (a.curator !== b.curator) return a.curator === 'editor' ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const counts = votes ? votesByPlugin(votes) : null;
  const sortedPlugins = [...plugins]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((plugin) => counts ? { ...plugin, votes: counts.get(plugin.id) ?? 0 } : plugin);
  return {
    schemaVersion: 1,
    generatedAt: generatedAt ?? votes?.generatedAt ?? new Date().toISOString(),
    source: 'dsh-market-data',
    plugins: sortedPlugins,
    groups: sortedGroups,
  };
}
