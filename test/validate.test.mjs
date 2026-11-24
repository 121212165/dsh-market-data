import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { validateDataset } from '../scripts/validate.mjs';
import { buildIndex } from '../scripts/build-index-lib.mjs';


const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures', 'bad');

const goodPlugin = {
  id: 'dsh-plugin-alpha',
  repo: '121212165/dsh-plugin-alpha',
  name: 'Alpha',
  oneLiner: 'does a thing',
  category: '钱与用量',
  entries: ['/alpha'],
  requires: ['tools'],
  dshRange: '>=0.1.2-rc.1 <0.2.0',
  license: 'MIT',
  author: '121212165',
  borrowedFrom: [],
  verifiedAt: '2026-11-20',
};

const goodGroup = {
  id: 'alpha-group',
  name: 'Alpha Group',
  oneLiner: 'one member',
  members: ['dsh-plugin-alpha'],
  why: ['alpha writes summary.json that beta reads'],
  installOrder: '按 members 顺序',
  conflicts: [],
  verify: ['dump-config 含 alpha'],
  curator: 'editor',
  updatedAt: '2026-11-21',
};

const wrap = (file, data) => ({ file, data });

test('good dataset is green', () => {
  const errors = validateDataset({
    plugins: [wrap('data/plugins/dsh-plugin-alpha.json', goodPlugin)],
    groups: [wrap('data/groups/alpha-group.json', goodGroup)],
    categories: ['钱与用量'],
  });
  assert.deepEqual(errors, []);
});

test('bad sample 1: duplicate id is reported red', () => {
  const errors = validateDataset({
    plugins: [
      wrap('data/plugins/dsh-plugin-alpha.json', goodPlugin),
      wrap('data/plugins/dsh-plugin-alpha-copy.json', { ...goodPlugin, repo: '121212165/other' }),
    ],
    groups: [],
  });
  assert.ok(errors.some((e) => e.includes('duplicate-id')), errors.join('\n'));
});

test('bad sample 2: dead repo link is reported red', () => {
  const errors = validateDataset({
    plugins: [wrap('data/plugins/dsh-plugin-dead.json', { ...goodPlugin, repo: 'example/gone' })],
    groups: [],
  });
  assert.ok(errors.some((e) => e.includes('dead-repo')), errors.join('\n'));
});

test('bad sample 3: group with missing why is reported red', () => {
  const errors = validateDataset({
    plugins: [wrap('data/plugins/dsh-plugin-alpha.json', goodPlugin)],
    groups: [wrap('data/groups/alpha-group.json', { ...goodGroup, why: [] })],
  });
  assert.ok(errors.some((e) => e.includes('why') && e.includes('empty')), errors.join('\n'));
});

test('bad sample: marketing why with no concrete contract is rejected', () => {
  const errors = validateDataset({
    plugins: [wrap('data/plugins/dsh-plugin-alpha.json', goodPlugin)],
    groups: [wrap('data/groups/alpha-group.json', { ...goodGroup, why: ['they work great together'] })],
  });
  assert.ok(errors.some((e) => e.includes('concrete handshake contract')), errors.join('\n'));
});

test('buildIndex produces same-shape index with generatedAt, editor groups first', () => {
  const index = buildIndex({
    plugins: [goodPlugin],
    groups: [
      { ...goodGroup, id: 'community-one', curator: 'community', updatedAt: '2026-11-21' },
      { ...goodGroup, id: 'editor-one', curator: 'editor', updatedAt: '2026-11-01' },
    ],
    generatedAt: '2026-11-21T00:00:00.000Z',
  });
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.generatedAt, '2026-11-21T00:00:00.000Z');
  assert.deepEqual(index.groups.map((g) => g.id), ['editor-one', 'community-one']);
  assert.deepEqual(Object.keys(index).sort(), ['generatedAt', 'groups', 'plugins', 'schemaVersion', 'source']);
});

test('checkRepo-free offline gate: canonical bad fixtures all report red', () => {
  const loadFixtures = (folder) => readdirSync(join(fixtures, folder))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = join(fixtures, folder, name);
      return { file, data: JSON.parse(readFileSync(file, 'utf8')) };
    });
  const errors = validateDataset({
    plugins: loadFixtures('plugins'),
    groups: loadFixtures('groups'),
  });
  assert.ok(errors.some((e) => e.includes('duplicate-id')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('dead-repo')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('why') && e.includes('empty')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('placeholder')), errors.join('\n'));
});

test('M1 built-in snapshot mirrors the current canonical catalog', () => {
  // In the main repo the plugin repo is a sibling; from a git worktree it is one level higher.
  const candidates = [
    join(root, '..', 'dsh-plugin-market', 'src', 'snapshot.json'),
    join(root, '..', '..', 'dsh-plugin-market', 'src', 'snapshot.json'),
  ];
  const snapshotPath = candidates.find((path) => existsSync(path));
  assert.ok(snapshotPath, `built-in snapshot not found in ${candidates.join(' or ')}`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.groups.length, 6);
  const catalogCount = readdirSync(join(root, 'data', 'plugins')).filter((name) => name.endsWith('.json')).length;
  assert.equal(snapshot.plugins.length, catalogCount);
  assert.ok(snapshot.generatedAt, 'snapshot must carry a generatedAt stamp');
  assert.deepEqual(
    snapshot.groups.map((group) => group.id).sort(),
    ['archive-chain', 'eco-radar', 'handoff-duo', 'plugin-dev', 'saving-combo', 'starter-three'],
  );
});
