/** Restore the one-file-per-entity sources from the built snapshot (the
 * authoritative copy of the 25-plugin / 6-group seed). Only files whose ids
 * exist in the snapshot are rewritten; newer entities are left untouched. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = join(root, '..', 'dsh-plugin-market', 'src', 'snapshot.json');
if (!existsSync(snapshotPath)) {
  console.error('no snapshot to restore from');
  process.exit(1);
}
const index = JSON.parse(readFileSync(snapshotPath, 'utf8'));
let restored = 0;
for (const [folder, entities] of [['plugins', index.plugins], ['groups', index.groups]]) {
  for (const entity of entities) {
    const path = join(root, 'data', folder, `${entity.id}.json`);
    writeFileSync(path, JSON.stringify(entity, null, 2) + '\n', 'utf8');
    restored++;
  }
}
console.log(`restored ${restored} source files from snapshot`);
