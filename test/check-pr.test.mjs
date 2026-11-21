import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { checkCrossEntry, checkEntry, loadDataset, runGate } from '../scripts/check-pr.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (...parts) => JSON.parse(readFileSync(join(root, 'test', 'fixtures', ...parts), 'utf8'));
const codes = (errors) => errors.map((error) => error.code);

test('占位字段：TODO/待补/TBD 报 PLACEHOLDER_FIELD 并带 entryPath', () => {
  const entryPath = 'data/groups/placeholder-only.json';
  const errors = checkEntry(entryPath, fixture('bad', 'groups', 'placeholder-only.json'));
  assert.ok(codes(errors).includes('PLACEHOLDER_FIELD'), JSON.stringify(errors));
  assert.ok(errors.every((error) => error.entryPath === entryPath), JSON.stringify(errors));
});

test('group 缺 why：空数组报 GROUP_MISSING_WHY', () => {
  const errors = checkEntry(
    'data/groups/missing-why.json',
    fixture('bad', 'groups', 'missing-why.json'),
  );
  assert.ok(codes(errors).includes('GROUP_MISSING_WHY'), JSON.stringify(errors));
  assert.ok(errors.some((error) => error.entryPath === 'data/groups/missing-why.json'));
});

test('verify 含糊：写「应该能用」报 VAGUE_VERIFY', () => {
  const errors = checkEntry(
    'data/groups/placeholder-only.json',
    fixture('bad', 'groups', 'placeholder-only.json'),
  );
  assert.ok(codes(errors).includes('VAGUE_VERIFY'), JSON.stringify(errors));
  assert.ok(
    errors.some((error) => error.code === 'VAGUE_VERIFY' && /应该能用/.test(error.detail)),
    JSON.stringify(errors),
  );
});

test('成员不存在：group.members 未命中 plugin id 报 UNKNOWN_MEMBER', () => {
  const groupPath = 'data/groups/unknown-member.json';
  const errors = checkCrossEntry({
    plugins: [{ file: 'data/plugins/dsh-plugin-quota.json', data: { id: 'dsh-plugin-quota' } }],
    groups: [{ file: groupPath, data: fixture('bad', 'groups', 'unknown-member.json') }],
  });
  assert.ok(codes(errors).includes('UNKNOWN_MEMBER'), JSON.stringify(errors));
  assert.ok(
    errors.some((error) => error.code === 'UNKNOWN_MEMBER' && error.entryPath === groupPath && /ghost/.test(error.detail)),
    JSON.stringify(errors),
  );
});

test('重复 id：plugin/group 同 id 报 DUPLICATE_ID，组内重复成员报 DUPLICATE_MEMBER', () => {
  const errors = checkCrossEntry({
    plugins: [
      { file: 'data/plugins/dsh-plugin-quota.json', data: { id: 'dsh-plugin-quota' } },
      { file: 'data/plugins/dsh-plugin-quota-copy.json', data: { id: 'dsh-plugin-quota' } },
    ],
    groups: [
      { file: 'data/groups/archive-chain.json', data: { id: 'archive-chain', members: ['dsh-plugin-quota'] } },
      { file: 'data/groups/archive-chain-copy.json', data: { id: 'archive-chain', members: ['dsh-plugin-quota'] } },
      { file: 'data/groups/duplicate-member.json', data: fixture('bad', 'groups', 'duplicate-member.json') },
    ],
  });
  assert.ok(codes(errors).includes('DUPLICATE_ID'), JSON.stringify(errors));
  assert.ok(
    errors.some((error) => error.code === 'DUPLICATE_ID' && error.entryPath === 'data/plugins/dsh-plugin-quota-copy.json'),
    JSON.stringify(errors),
  );
  assert.ok(
    errors.some((error) => error.code === 'DUPLICATE_ID' && error.entryPath === 'data/groups/archive-chain-copy.json'),
    JSON.stringify(errors),
  );
  assert.ok(
    errors.some((error) => error.code === 'DUPLICATE_MEMBER' && /dsh-plugin-quota/.test(error.detail)),
    JSON.stringify(errors),
  );
});

test('真实 data/：25 插件 + 6 组合全绿（0 错误）', () => {
  const dataset = loadDataset(root);
  const files = [...dataset.plugins, ...dataset.groups].map((entry) => entry.file);
  const report = runGate(files, root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(files.length, 31);
});
