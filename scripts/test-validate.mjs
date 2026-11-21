import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const VALIDATE = path.join(ROOT, 'scripts', 'validate.mjs');
const FIX = path.join(ROOT, 'test', 'fixtures', 'bad');
const countJson = (dir) => fs.readdirSync(path.join(ROOT, 'data', dir)).filter((f) => f.endsWith('.json') && f !== 'categories.json').length;
const N_PLUGINS = countJson('plugins');
const N_GROUPS = countJson('groups');

function run(args) {
  const r = spawnSync(process.execPath, [VALIDATE, ...args], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* ignore */ }
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr };
}

const cases = [
  {
    name: `好数据全绿（${N_PLUGINS} 插件 + ${N_GROUPS} 组，offline）`,
    args: ['--offline', '--json'],
    expect: (r) => r.status === 0 && r.report?.ok === true &&
      r.report.counts.plugins === N_PLUGINS && r.report.counts.groups === N_GROUPS &&
      r.report.counts.errors === 0,
    detail: (r) => `errors=${r.report?.counts?.errors} plugins=${r.report?.counts?.plugins} groups=${r.report?.counts?.groups}`,
  },
  {
    name: '坏样本①：重复 id 报红',
    args: ['--offline', '--json', '--extra', path.join(FIX, 'plugins', 'duplicate-id.json')],
    expect: (r) => r.status !== 0 && r.report?.errors?.some((e) => e.code === 'DUPLICATE_PLUGIN_ID'),
    detail: (r) => (r.report?.errors || []).map((e) => e.code).join(','),
  },
  {
    name: '坏样本②：死链 repo 报红（在线）',
    args: ['--json', '--extra', path.join(FIX, 'plugins', 'dead-repo.json')],
    expect: (r) => r.status !== 0 && r.report?.errors?.some((e) => e.code === 'DEAD_REPO'),
    detail: (r) => (r.report?.errors || []).map((e) => e.code).join(','),
  },
  {
    name: '坏样本③：缺 why 报红',
    args: ['--offline', '--json', '--extra', path.join(FIX, 'groups', 'missing-why.json')],
    expect: (r) => r.status !== 0 && r.report?.errors?.some((e) => e.code === 'GROUP_MISSING_WHY'),
    detail: (r) => (r.report?.errors || []).map((e) => e.code).join(','),
  },
  {
    name: 'M4：只有占位字段的 PR 被 Action 打回',
    args: ['--offline', '--json', '--extra', path.join(FIX, 'groups', 'placeholder-only.json')],
    expect: (r) => r.status !== 0 && r.report?.errors?.some((e) => e.code === 'PLACEHOLDER_FIELD'),
    detail: (r) => (r.report?.errors || []).map((e) => e.code).join(','),
  },
];

console.log('M0 validate 验收证据\n');
let failed = 0;
for (const c of cases) {
  const r = run(c.args);
  const pass = c.expect(r);
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail(r)}`);
  if (!pass && r.stderr) console.log(`      stderr: ${r.stderr.trim().slice(0, 300)}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
