/**
 * F1 verification evidence (Node, zero deps). Aggregates the four submission
 * samples + the PR-body/verify-plugin contract into f1-report.json.
 *
 * Honesty note: there is no gh identity or remote in this local worktree, so
 * the GitHub Action itself is NOT executed here. The verify-plugin section is
 * exercised with an injected deterministic report; the real Action runs the
 * vendored tool against the submitted repo.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIssueBody, renderPrBody, validateSubmission } from './submission.mjs';
import { runVerifyPlugin } from './verify-plugin-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const STAMP = '2026-11-23';
const checks = {};
const errors = [];

const samples = {};
for (const name of ['good', 'missing-license', 'missing-borrowed', 'duplicate-id']) {
  const fields = parseIssueBody(read(`test/fixtures/submissions/${name}.md`));
  samples[name] = validateSubmission(fields, { root: ROOT, today: STAMP });
}

/* Acceptance 1 — a submission without license is rejected. */
const missingLicenseCodes = samples['missing-license'].errors.map((e) => e.code);
checks.missingLicenseRejected = !samples['missing-license'].ok && missingLicenseCodes.includes('MISSING_LICENSE');
if (!checks.missingLicenseRejected) errors.push('missing-license submission was not rejected');

/* The other two bad samples must also be red. */
checks.missingBorrowedRejected = !samples['missing-borrowed'].ok
  && samples['missing-borrowed'].errors.some((e) => e.code === 'MISSING_BORROWED_FROM');
checks.duplicateIdRejected = !samples['duplicate-id'].ok
  && samples['duplicate-id'].errors.some((e) => e.code === 'DUPLICATE_ID');
if (!checks.missingBorrowedRejected) errors.push('missing-borrowed-from submission was not rejected');
if (!checks.duplicateIdRejected) errors.push('duplicate-id submission was not rejected');

/* Acceptance 2 — a good submission is green and produces a draft. */
checks.goodSubmissionAccepted = samples.good.ok && Boolean(samples.good.draftPath);
if (!checks.goodSubmissionAccepted) errors.push(`good submission rejected: ${JSON.stringify(samples.good.errors)}`);

/* PR body must carry the validation result and the verbatim verify output. */
const verify = runVerifyPlugin({
  pluginDir: 'submitted-plugin',
  run: () => 'OK: all plugin specs pass\n结果: 1 插件 / 0 FAIL / 0 WARN',
});
const prBody = renderPrBody(samples.good, verify, { issueNumber: 0 });
checks.prBodyHasValidation = /validate\.mjs/.test(prBody) && /check-pr\.mjs/.test(prBody) && /PASS/.test(prBody);
checks.prBodyHasVerifyOutput = verify.ok && prBody.includes(verify.output);
if (!checks.prBodyHasValidation) errors.push('PR body lacks validation result');
if (!checks.prBodyHasVerifyOutput) errors.push('PR body lacks verify-plugin output');

/* The workflow must actually route through both gates and open a PR. */
const workflow = read('.github/workflows/submission.yml');
const form = read('.github/ISSUE_TEMPLATE/plugin-submission.yml');
checks.issueFormHasThreeRequired = (form.match(/required: true/g) ?? []).length === 3;
checks.workflowReusesGates = /scripts\/validate\.mjs/.test(workflow) && /scripts\/check-pr\.mjs/.test(workflow);
checks.workflowOpensPr = /peter-evans\/create-pull-request/.test(workflow) && /body-path: pr-body\.md/.test(workflow);
if (!checks.issueFormHasThreeRequired) errors.push('issue form does not have exactly three required fields');
if (!checks.workflowReusesGates) errors.push('workflow does not reuse both existing gates');
if (!checks.workflowOpensPr) errors.push('workflow does not open a PR with the rendered body');

const report = {
  milestone: 'F1',
  generatedAt: new Date().toISOString(),
  samples: Object.fromEntries(Object.entries(samples).map(([name, result]) => [name, {
    ok: result.ok,
    codes: result.errors.map((e) => e.code),
    draftPath: result.draftPath,
  }])),
  verifyPlugin: verify,
  criteria: checks,
  errors,
  pass: errors.length === 0,
  honesty: '本地无 gh 身份/远程，Actions 未实跑；verify-plugin 以注入的确定性报告复验 PR 正文包含关系，'
    + '真实 Action 在 GitHub 上对投稿 repo 跑 vendored 工具。等价复验口径沿用 M4 诚实声明。',
};
writeFileSync(join(ROOT, 'f1-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(checks, null, 2));
console.log(report.pass ? 'PASS' : `FAIL: ${errors.join('; ')}`);
process.exit(report.pass ? 0 : 1);
