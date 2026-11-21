/** Pure index builder (library form), kept separate from the CLI build-index.mjs
 *  so other milestone sessions can own the CLI without breaking M1 tests. */
export function buildIndex({ plugins, groups, generatedAt = new Date().toISOString() }) {
  const sortedGroups = [...groups].sort((a, b) => {
    if (a.curator !== b.curator) return a.curator === 'editor' ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const sortedPlugins = [...plugins].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    schemaVersion: 1,
    generatedAt,
    source: 'dsh-market-data',
    plugins: sortedPlugins,
    groups: sortedGroups,
  };
}
