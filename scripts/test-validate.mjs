/**
 * M0/M4 validate regression evidence (zero deps, offline).
 *
 * This used to drive CLI flags (--json / --extra) that the current
 * scripts/validate.mjs no longer exposes. It now calls the same exported
 * rule engine (`validateDataset`) directly, so `node --test` stays green and
 * the checks still exercise the canonical bad fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';

import { validateDataset } from './validate.mjs';
import { ROOT } from './lib.mjs';

const FIX = path.join(ROOT, 'test', 'fixtures', 'bad');
const N_PLUGINS = fs.readdirSync(path.join(ROOT, 'data', 'plugins')).filter((f) => f.endsWith('.json')).length;
const N_GROUPS = fs.readdirSync(path.join(ROOT, 'data', 'groups')).filter((f) => f.endsWith('.json')).length;

function loadDir(folder) {
  return fs.readdirSync(path.join(ROOT, 'data', folder))
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      file: `data/${folder}/${name}`,
      data: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', folder, name), 'utf8')),
    }));
}

function loadFixture(folder, name) {
  const file = path.join(FIX, folder, name);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const base = { plugins: loadDir('plugins'), groups: loadDir('groups') };
const errorsOf = (input) => validateDataset({
  ...input,
  categories: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8')),
});

const cases = [
  {
    name: `好数据全绿（${N_PLUGINS} 插件 + ${N_GROUPS} 组，offline）`,
    run: () => errorsOf(base),
    expect: (errors) => errors.length === 0,
    detail: (errors) => `errors=${errors.length} plugins=${N_PLUGINS} groups=${N_GROUPS}`,
  },
  {
    name: '坏样本①：重复 id 报红',
    run: () => errorsOf({ ...base, plugins: [...base.plugins, loadFixture('plugins', 'duplicate-id.json')] }),
    expect: (errors) => errors.some((e) => e.includes('duplicate-id')),
    detail: (errors) => errors.filter((e) => e.includes('duplicate-id')).join(', '),
  },
  {
    name: '坏样本②：死链 repo 报红（offline 语义判定）',
    run: () => errorsOf({ ...base, plugins: [...base.plugins, loadFixture('plugins', 'dead-repo.json')] }),
    expect: (errors) => errors.some((e) => e.includes('dead-repo')),
    detail: (errors) => errors.filter((e) => e.includes('dead-repo')).join(', '),
  },
  {
    name: '坏样本③：缺 why 报红',
    run: () => errorsOf({ ...base, groups: [...base.groups, loadFixture('groups', 'missing-why.json')] }),
    expect: (errors) => errors.some((e) => e.includes('why') && e.includes('empty')),
    detail: (errors) => errors.filter((e) => e.includes('why')).join(', '),
  },
  {
    name: 'M4：只有占位字段的 PR 被 Action 打回',
    run: () => errorsOf({ ...base, groups: [...base.groups, loadFixture('groups', 'placeholder-only.json')] }),
    expect: (errors) => errors.some((e) => e.includes('placeholder')),
    detail: (errors) => errors.filter((e) => e.includes('placeholder')).join(', '),
  },
];

console.log('M0 validate 验收证据（复用 validateDataset）\n');
let failed = 0;
for (const testCase of cases) {
  let errors = [];
  let pass = false;
  try {
    errors = testCase.run();
    pass = testCase.expect(errors);
  } catch (error) {
    errors = [String(error?.stack ?? error)];
  }
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}`);
  console.log(`      ${testCase.detail(errors)}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
