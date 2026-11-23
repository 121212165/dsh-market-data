/** Rebuild the read contract from one-file-per-entity sources.
 *  index.json / snapshot.json / dsh-plugin-market/src/snapshot.json are written
 *  from the SAME object, so they are structurally identical (M0: 同构). */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './build-index-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readDir = (name) => readdirSync(join(root, 'data', name))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(root, 'data', name, file), 'utf8')));

// F2: the vote snapshot (when present) is the single source of both the per-
// plugin `votes` field and the index generatedAt. Re-running the snapshot moves
// both together, so a stale page can be detected by the 24h rule (§5.1).
const votesFile = join(root, 'data', 'votes.json');
const votes = existsSync(votesFile) ? JSON.parse(readFileSync(votesFile, 'utf8')) : null;
const index = buildIndex({ plugins: readDir('plugins'), groups: readDir('groups'), votes });
const write = (target) => {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(index, null, 2) + '\n', 'utf8');
};

write(join(root, 'data', 'index.json'));
write(join(root, 'data', 'snapshot.json'));
const embedded = join(root, '..', 'dsh-plugin-market', 'src', 'snapshot.json');
if (existsSync(dirname(embedded))) write(embedded);

console.log(`index.json: ${index.plugins.length} plugins, ${index.groups.length} groups, ${index.generatedAt}`);
console.log(votes
  ? `votes: ${votes.summary?.countedVotes ?? 0} valid from ${votes.summary?.discussions ?? 0} Discussions (snapshot ${votes.generatedAt})`
  : 'votes: no data/votes.json yet — run scripts/vote-snapshot.mjs first');
console.log('snapshot.json + dsh-plugin-market/src/snapshot.json written from the same object (同构)');
