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

const index = buildIndex({ plugins: readDir('plugins'), groups: readDir('groups') });
const write = (target) => {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(index, null, 2) + '\n', 'utf8');
};

write(join(root, 'data', 'index.json'));
write(join(root, 'data', 'snapshot.json'));
const embedded = join(root, '..', 'dsh-plugin-market', 'src', 'snapshot.json');
if (existsSync(dirname(embedded))) write(embedded);

console.log(`index.json: ${index.plugins.length} plugins, ${index.groups.length} groups, ${index.generatedAt}`);
console.log('snapshot.json + dsh-plugin-market/src/snapshot.json written from the same object (同构)');
