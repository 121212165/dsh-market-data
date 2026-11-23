import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildDraft,
  parseBorrowedTable,
  parseIssueBody,
  renderIssueComment,
  renderPrBody,
  validateSubmission,
} from '../scripts/submission.mjs';
import { runVerifyPlugin, VERIFIER } from '../scripts/verify-plugin-gate.mjs';
import { checkCrossEntry, checkEntry } from '../scripts/check-pr.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const issue = (name) => parseIssueBody(read('test', 'fixtures', 'submissions', `${name}.md`));
const codes = (report) => report.errors.map((error) => error.code);
const STAMP = '2026-11-23';

test('parseIssueBody: 解析三个必填字段与选填字段', () => {
  const fields = issue('good');
  assert.equal(fields.repo, '121212165/dsh-plugin-submission-demo');
  assert.equal(fields.license, 'MIT');
  assert.equal(fields.borrowedFrom.length, 2);
  assert.ok(fields.borrowedFrom[0].includes('dsh-plugin-quota'));
  assert.equal(fields.category, '工具与质量');
  assert.deepEqual(fields.entries, ['/demo-submission', 'demo_submission']);
});

test('parseBorrowedTable: 只留表头/分隔行不算来源', () => {
  assert.deepEqual(parseBorrowedTable('| repo | 借鉴了什么 | 许可 |\n| --- | --- | --- |'), []);
  assert.deepEqual(parseBorrowedTable('- 121212165/dsh-plugin-quota — 配额契约 (MIT)'), [
    '121212165/dsh-plugin-quota — 配额契约 (MIT)',
  ]);
});

test('坏样本①：缺 license 的投稿被拒 (MISSING_LICENSE)', () => {
  const report = validateSubmission(issue('missing-license'), { root, today: STAMP });
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes('MISSING_LICENSE'), JSON.stringify(report.errors));
  assert.equal(report.draft, null, 'form-level rejection must not produce a draft');
  assert.match(renderIssueComment(report), /MISSING_LICENSE/);
});

test('坏样本②：缺借鉴来源表的投稿被拒 (MISSING_BORROWED_FROM)', () => {
  const report = validateSubmission(issue('missing-borrowed'), { root, today: STAMP });
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes('MISSING_BORROWED_FROM'), JSON.stringify(report.errors));
});

test('坏样本③：重复 id 的投稿被拒 (DUPLICATE_ID)', () => {
  const report = validateSubmission(issue('duplicate-id'), { root, today: STAMP });
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes('DUPLICATE_ID'), JSON.stringify(report.errors));
  assert.equal(report.draftPath, 'data/plugins/dsh-plugin-quota.json');
});

test('合格样本：validateDataset + check-pr 两道门禁全绿，草稿字段完整', () => {
  const report = validateSubmission(issue('good'), { root, today: STAMP });
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors, null, 2));
  assert.equal(report.ok, true);
  assert.equal(report.draftPath, 'data/plugins/dsh-plugin-submission-demo.json');
  assert.equal(report.checks.validate.ok, true);
  assert.equal(report.checks.checkPr.ok, true);
  assert.equal(report.checks.validate.pluginCount, 26); // 25 existing + draft
  assert.deepEqual(report.draft.borrowedFrom, issue('good').borrowedFrom);
  assert.equal(report.draft.verifiedAt, STAMP);
  assert.equal(report.draft.id, 'dsh-plugin-submission-demo');
  assert.ok(!Object.values(report.draft).some((v) => typeof v === 'string' && /TODO|TBD|待补|占位/i.test(v)));
});

test('合格草稿直接过 checkEntry / checkCrossEntry（复用现有门禁）', () => {
  const report = validateSubmission(issue('good'), { root, today: STAMP });
  assert.deepEqual(checkEntry(report.draftPath, report.draft), []);
  const dataset = checkCrossEntry({
    plugins: [{ file: report.draftPath, data: report.draft }],
    groups: [],
  });
  assert.deepEqual(dataset, []);
});

test('buildDraft: 选填字段留空时用具体默认值，不产生占位词', () => {
  const { entry } = buildDraft(
    { repo: '121212165/dsh-plugin-new-one', license: 'MIT', borrowedFrom: ['121212165/quota — x (MIT)'] },
    { today: STAMP, categories: ['工具与质量'] },
  );
  assert.equal(entry.id, 'dsh-plugin-new-one');
  assert.equal(entry.name, 'new-one');
  assert.equal(entry.oneLiner, '社区投稿：121212165/dsh-plugin-new-one');
  assert.deepEqual(entry.entries, ['/new-one']);
  assert.equal(entry.category, '工具与质量');
  assert.equal(entry.author, '121212165');
});

test('PR 正文包含校验结果与 verify-plugin 原始输出', () => {
  const report = validateSubmission(issue('good'), { root, today: STAMP });
  const verify = {
    ok: true,
    command: 'node scripts/vendor/verify-plugin.mjs submitted-plugin',
    output: 'OK: all plugin specs pass\n结果: 1 插件 / 0 FAIL / 0 WARN',
  };
  const body = renderPrBody(report, verify, { issueNumber: 42 });
  assert.match(body, /PASS/);
  assert.match(body, /validate\.mjs/);
  assert.match(body, /check-pr\.mjs/);
  assert.ok(body.includes(verify.output), 'verify-plugin output must be embedded verbatim');
  assert.match(body, /#42/);
  assert.match(body, /dsh-plugin-submission-demo\.json/);
});

test('verify-plugin gate: 注入的 run 同时覆盖 PASS 与 FAIL 两条路径', () => {
  const good = runVerifyPlugin({
    pluginDir: 'submitted-plugin',
    run: () => 'OK: all plugin specs pass\n结果: 1 插件 / 0 FAIL / 0 WARN',
  });
  assert.equal(good.ok, true);
  assert.match(good.output, /0 FAIL/);
  assert.match(good.command, /vendor\/verify-plugin\.mjs/);

  const failure = new Error('exit 1');
  failure.stdout = 'FAIL:\n  quota: G0-6: locale 缺键\n结果: 1 插件 / 1 FAIL / 0 WARN';
  const bad = runVerifyPlugin({ pluginDir: 'submitted-plugin', run: () => { throw failure; } });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /G0-6/);
});

test('vendored verifier 带来源头，逻辑文件存在', () => {
  const vendored = readFileSync(VERIFIER, 'utf8');
  assert.match(vendored, /Vendored from 121212165\/dsh-family-tools/);
  assert.match(vendored, /tools\/verify-plugin\.mjs/);
});

test('Issue Form 三个必填字段 + 工作流复用两道门禁并开 PR', () => {
  const form = read('.github', 'ISSUE_TEMPLATE', 'plugin-submission.yml');
  for (const id of ['id: repo', 'id: license', 'id: borrowed-from']) assert.ok(form.includes(id), `missing ${id}`);
  assert.equal((form.match(/required: true/g) ?? []).length, 3);
  assert.match(form, /owner\/name/);

  const workflow = read('.github', 'workflows', 'submission.yml');
  assert.match(workflow, /issues:/);
  assert.match(workflow, /scripts\/validate\.mjs/);
  assert.match(workflow, /scripts\/check-pr\.mjs/);
  assert.match(workflow, /verify-plugin-gate\.mjs/);
  assert.match(workflow, /peter-evans\/create-pull-request/);
  assert.match(workflow, /body-path: pr-body\.md/);
});
