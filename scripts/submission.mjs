/**
 * F1 submission pipeline: Issue Form -> draft plugin entry -> existing gates -> PR.
 *
 * This module does NOT invent new data rules. It reuses:
 *   - scripts/validate.mjs      `validateDataset` (schema + semantic dataset rules)
 *   - scripts/check-pr.mjs      `checkEntry` / `checkCrossEntry` (PR gate rules)
 * and only adds the Issue-Form-specific layer: field parsing, required-field
 * checks (repo / license / 借鉴来源表) and the draft-entry mapping.
 *
 * CLI:
 *   node scripts/submission.mjs check   --issue <file> [--json]
 *   node scripts/submission.mjs prepare --issue <file> --state <file> [--number N]
 *   node scripts/submission.mjs validate --state <file> --report <file>
 *   node scripts/submission.mjs gate --report <file>
 *   node scripts/submission.mjs pr-body --report <file> --verify <file> --out <file>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCrossEntry, checkEntry, loadDataset } from './check-pr.mjs';
import { validateDataset } from './validate.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'];
const DEFAULT_CATEGORY = '工具与质量';
const DEFAULT_DSH_RANGE = '>=0.1.2-rc.1 <0.2.0';

const LABELS = {
  repo: 'repo',
  '仓库': 'repo',
  '仓库地址': 'repo',
  'github repo': 'repo',
  license: 'license',
  '许可证': 'license',
  '开源许可': 'license',
  '许可': 'license',
  '借鉴来源表': 'borrowedFrom',
  '借鉴来源': 'borrowedFrom',
  '来源表': 'borrowedFrom',
  borrowedfrom: 'borrowedFrom',
  'borrowed from': 'borrowedFrom',
  'borrowed-from': 'borrowedFrom',
  name: 'name',
  '名称': 'name',
  'one-liner': 'oneLiner',
  oneliner: 'oneLiner',
  '一句话': 'oneLiner',
  '一句话介绍': 'oneLiner',
  category: 'category',
  '分类': 'category',
  entries: 'entries',
  '入口': 'entries',
  '命令': 'entries',
  npm: 'npm',
  'dsh-range': 'dshRange',
  dshrange: 'dshRange',
  'dsh 版本': 'dshRange',
  author: 'author',
  '作者': 'author',
};

const today = () => new Date().toISOString().slice(0, 10);

function canonicalLabel(raw) {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[\d.、)\s]+/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
  return LABELS[key] ?? key;
}

function readJson(root, rel, fallback) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSchemas(root) {
  const plugin = readJson(root, 'schema/plugin.schema.json', null);
  const group = readJson(root, 'schema/group.schema.json', null);
  return plugin || group ? { plugin, group } : {};
}

/** Parse the markdown table (or bullet list) in the 借鉴来源表 field. */
export function parseBorrowedTable(value = '') {
  const rows = [];
  for (const line of String(value ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (!cells.length || cells.every((cell) => !cell || /^:?-{2,}:?$/.test(cell))) continue; // separator
      if (/^(repo|仓库|来源|来源仓库|source|项目)$/i.test(cells[0]) && /用途|许可|purpose|license|借鉴/i.test(cells.join(' '))) continue; // header
      const text = cells.filter(Boolean).join(' — ');
      if (text) rows.push(text);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) rows.push(bullet[1].trim());
  }
  return rows;
}

function parseEntries(value) {
  if (!value) return [];
  return String(value).split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse a GitHub Issue Form body. Supports `### label` and `**label**` styles;
 * labels may carry a （必填）/ (required) suffix and Chinese/English aliases.
 */
export function parseIssueBody(body = '') {
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  const headers = [];
  const re = /^#{2,4}[ \t]+(.+?)[ \t]*$|^\*\*(.+?)\*\*[ \t]*$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    headers.push({ label: (match[1] ?? match[2] ?? '').trim(), start: match.index, valueStart: re.lastIndex });
  }
  const raw = {};
  headers.forEach((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].start : text.length;
    const key = canonicalLabel(header.label);
    const value = text.slice(header.valueStart, end).trim();
    raw[key] = raw[key] ? `${raw[key]}\n${value}` : value;
  });
  return {
    repo: (raw.repo ?? '').trim(),
    license: (raw.license ?? '').trim(),
    borrowedFrom: parseBorrowedTable(raw.borrowedFrom ?? ''),
    name: (raw.name ?? '').trim(),
    oneLiner: (raw.oneLiner ?? '').trim(),
    category: (raw.category ?? '').trim(),
    entries: parseEntries(raw.entries),
    npm: (raw.npm ?? '').trim(),
    dshRange: (raw.dshRange ?? '').trim(),
    author: (raw.author ?? '').trim(),
  };
}

const slugify = (name) => String(name ?? '')
  .toLowerCase()
  .replace(/^dsh-plugin-/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'plugin';

/** Map a valid submission to a draft `data/plugins/<id>.json` entry. */
export function buildDraft(fields = {}, { today: stamp = today(), categories = [] } = {}) {
  const repo = (fields.repo ?? '').trim();
  const slug = slugify(repo.split('/')[1] ?? '');
  const id = `dsh-plugin-${slug}`;
  const entry = {
    id,
    repo,
    name: (fields.name ?? '').trim() || slug,
    oneLiner: (fields.oneLiner ?? '').trim() || `社区投稿：${repo}`,
    category: categories.includes(fields.category) ? fields.category.trim() : (categories[0] ?? DEFAULT_CATEGORY),
    entries: Array.isArray(fields.entries) && fields.entries.length ? fields.entries : [`/${slug}`],
    requires: [],
    dshRange: (fields.dshRange ?? '').trim() || DEFAULT_DSH_RANGE,
    license: (fields.license ?? '').trim(),
    author: (fields.author ?? '').trim() || repo.split('/')[0],
    borrowedFrom: Array.isArray(fields.borrowedFrom) ? fields.borrowedFrom : [],
    verifiedAt: stamp,
  };
  if ((fields.npm ?? '').trim()) entry.npm = fields.npm.trim();
  return { entry, path: `data/plugins/${id}.json` };
}

function normalizeValidateError(message, fallbackPath) {
  const match = String(message).match(/^([^:]+):\s*([^—]+?)\s*—\s*(.*)$/);
  if (!match) return { code: 'VALIDATE_ERROR', detail: String(message), entryPath: fallbackPath };
  const rule = match[2].trim();
  const code = rule === 'duplicate-id'
    ? 'DUPLICATE_ID'
    : rule.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { code, detail: match[3].trim(), entryPath: match[1] };
}

function dedupe(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.entryPath}|${error.code}|${error.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Full F1 validation. Form-level errors short-circuit; otherwise the candidate
 * dataset (existing data/ + draft) is handed to the two existing rule engines.
 */
export function validateSubmission(fields = {}, { root = ROOT, today: stamp = today(), categories, schemas } = {}) {
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail, entryPath: '' });
  const repo = (fields.repo ?? '').trim();
  const license = (fields.license ?? '').trim();
  const borrowedFrom = Array.isArray(fields.borrowedFrom) ? fields.borrowedFrom : [];

  if (!repo) add('MISSING_REPO', 'Issue 表单必须填写 repo（owner/name）');
  else if (!REPO_RE.test(repo)) add('INVALID_REPO', `repo \`${repo}\` 必须是 owner/name 格式`);
  if (!license) add('MISSING_LICENSE', 'Issue 表单必须填写 license（MIT / Apache-2.0 / BSD-3-Clause / ISC），缺 license 的投稿一律拒绝');
  else if (!ALLOWED_LICENSES.includes(license)) add('INVALID_LICENSE', `license \`${license}\` 不在允许列表`);
  if (!borrowedFrom.length) add('MISSING_BORROWED_FROM', '借鉴来源表至少要有一行真实来源（repo / 借鉴了什么 / 许可）');

  const categoryList = categories ?? readJson(root, 'data/categories.json', []);
  const schemaSet = schemas ?? loadSchemas(root);
  const dataset = loadDataset(root);

  const emptyChecks = {
    form: { ok: errors.length === 0, errors: [...errors] },
    validate: { ok: false, errors: [], pluginCount: dataset.plugins.length, groupCount: dataset.groups.length },
    checkPr: { ok: false, errors: [] },
  };
  if (errors.length) {
    return { ok: false, errors, checks: emptyChecks, draft: null, draftPath: null, repo, license, borrowedFrom };
  }

  const { entry, path } = buildDraft(fields, { today: stamp, categories: categoryList });
  // `prepare` writes the draft into data/plugins before `validate` runs. Drop
  // the identical on-disk copy so it is not counted twice; keep a conflicting
  // file at the same path (duplicate-id submissions) so the gate still sees it.
  const onDisk = dataset.plugins.filter(({ file, data }) => !(file === path && JSON.stringify(data) === JSON.stringify(entry)));
  const plugins = [...onDisk, { file: path, data: entry }];
  const validateErrors = validateDataset({
    plugins,
    groups: dataset.groups,
    categories: categoryList,
    schemas: schemaSet,
  }).map((message) => normalizeValidateError(message, path));
  const checkPrErrors = [
    ...checkEntry(path, entry),
    ...checkCrossEntry({ plugins, groups: dataset.groups }),
  ];
  const all = dedupe([...errors, ...validateErrors, ...checkPrErrors]);

  return {
    ok: all.length === 0,
    errors: all,
    draft: entry,
    draftPath: path,
    checks: {
      form: { ok: true, errors: [] },
      validate: { ok: validateErrors.length === 0, errors: validateErrors, pluginCount: plugins.length, groupCount: dataset.groups.length },
      checkPr: { ok: checkPrErrors.length === 0, errors: checkPrErrors },
    },
    repo,
    license,
    borrowedFrom,
  };
}

/** PR body — validation result + verbatim verify-plugin output. */
export function renderPrBody(report = {}, verify = null, { issueNumber } = {}) {
  const lines = [];
  lines.push('## 投稿摘要');
  lines.push(`- repo: \`${report.repo ?? ''}\``);
  lines.push(`- license: \`${report.license ?? ''}\``);
  lines.push(`- 借鉴来源表: ${(report.borrowedFrom ?? []).length} 条`);
  if (issueNumber) lines.push(`- 来源 Issue: #${issueNumber}`);
  lines.push('');
  lines.push('## 校验结果');
  lines.push(`**结论：${report.ok ? 'PASS（已通过投稿门禁）' : 'FAIL（未通过投稿门禁）'}**`);
  lines.push('');
  lines.push('| 门禁 | 结果 |');
  lines.push('| --- | --- |');
  lines.push(`| Issue 必填字段（repo / license / 借鉴来源表） | ${report.checks?.form?.ok ? 'PASS' : 'FAIL'} |`);
  lines.push(`| \`scripts/validate.mjs\` → validateDataset | ${report.checks?.validate?.ok ? 'PASS' : 'FAIL'} |`);
  lines.push(`| \`scripts/check-pr.mjs\` → checkEntry/checkCrossEntry | ${report.checks?.checkPr?.ok ? 'PASS' : 'FAIL'} |`);
  lines.push(`| vendored \`verify-plugin\` | ${verify?.ok ? 'PASS' : 'FAIL'} |`);
  if (report.errors?.length) {
    lines.push('');
    lines.push('错误明细：');
    for (const error of report.errors) {
      lines.push(`- \`${error.code}\` — ${error.detail}${error.entryPath ? ` (${error.entryPath})` : ''}`);
    }
  }
  lines.push('');
  lines.push('## verify-plugin 输出');
  lines.push(`命令：\`${verify?.command ?? 'node scripts/vendor/verify-plugin.mjs <pluginDir>'}\``);
  lines.push(`状态：${verify?.ok ? 'PASS' : 'FAIL'}`);
  lines.push('````text');
  lines.push(String(verify?.output ?? '(未提供 verify-plugin 输出)').trim());
  lines.push('````');
  lines.push('');
  lines.push('## 变更文件');
  lines.push(`- \`${report.draftPath ?? '(无)'}\``);
  lines.push('');
  lines.push('> 由 F1 投稿 Action 自动生成；`data/index.json` 由合并后的 build 流程生成，请勿手改。');
  return `${lines.join('\n')}\n`;
}

/** Rejection comment posted back on the issue. */
export function renderIssueComment(report = {}, verify = null) {
  const lines = [
    '## 投稿未通过 F1 门禁',
    '',
    `校验结论：**${report.ok ? 'PASS' : 'FAIL'}**`,
  ];
  if (report.errors?.length) {
    lines.push('', '错误明细：');
    for (const error of report.errors) lines.push(`- \`${error.code}\` — ${error.detail}`);
  }
  if (verify && !verify.ok) {
    lines.push('', 'verify-plugin 输出：', '````text', String(verify.output).trim(), '````');
  }
  lines.push('', '请修正 Issue 表单字段后重新提交（编辑本 Issue 会重新触发 Action）。');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------- CLI ----------------------------------- */

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function readIssue(source) {
  if (source && existsSync(source)) return readFileSync(source, 'utf8');
  if (process.env.ISSUE_BODY) return process.env.ISSUE_BODY;
  throw new Error('no issue body: pass --issue <file> or set ISSUE_BODY');
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsOf(rest);
  const root = args.root ? resolve(args.root) : ROOT;

  if (command === 'check') {
    const fields = parseIssueBody(readIssue(args.issue));
    const report = validateSubmission(fields, { root, today: args.today });
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      console.log(`submission: ${report.ok ? 'green' : `${report.errors.length} error(s)`}`);
      for (const error of report.errors) console.log(`  ✗ ${error.code} — ${error.detail}`);
    }
    process.exit(report.ok ? 0 : 1);
  }

  if (command === 'prepare') {
    const fields = parseIssueBody(readIssue(args.issue));
    const stamp = args.today || today();
    const report = validateSubmission(fields, { root, today: stamp });
    if (report.ok) {
      const abs = join(root, report.draftPath);
      writeFileSync(abs, `${JSON.stringify(report.draft, null, 2)}\n`, 'utf8');
    }
    const state = {
      issueNumber: args.number || process.env.ISSUE_NUMBER || '',
      today: stamp,
      fields,
      repo: report.repo,
      draft: report.draft,
      draftPath: report.draftPath,
      formErrors: report.checks.form.errors,
    };
    const json = `${JSON.stringify(state, null, 2)}\n`;
    if (args.state) writeFileSync(resolve(args.state), json, 'utf8');
    else process.stdout.write(json);
    console.error(`prepare: draft ${report.draftPath ?? '(rejected at form level)'} — ${report.ok ? 'ready' : 'form errors present'}`);
    process.exit(0); // prepare never blocks: the rejection step reports the reason
  }

  if (command === 'validate') {
    const state = JSON.parse(readFileSync(resolve(args.state), 'utf8'));
    const report = validateSubmission(state.fields, { root, today: state.today });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.report) writeFileSync(resolve(args.report), json, 'utf8');
    else process.stdout.write(json);
    console.error(`validate: ${report.ok ? 'green' : `${report.errors.length} error(s)`} (draft ${report.draftPath ?? 'n/a'})`);
    process.exit(0); // gate command owns the exit code
  }

  if (command === 'gate') {
    const report = JSON.parse(readFileSync(resolve(args.report), 'utf8'));
    console.log(report.ok ? 'PASS: submission gate green' : `FAIL: ${report.errors.map((e) => e.code).join(', ')}`);
    process.exit(report.ok ? 0 : 1);
  }

  if (command === 'pr-body') {
    const report = JSON.parse(readFileSync(resolve(args.report), 'utf8'));
    let verify = null;
    if (args.verify && existsSync(resolve(args.verify))) verify = JSON.parse(readFileSync(resolve(args.verify), 'utf8'));
    const body = renderPrBody(report, verify, { issueNumber: args.number });
    if (args.out) writeFileSync(resolve(args.out), body, 'utf8');
    else process.stdout.write(body);
    process.exit(0);
  }

  console.error(`unknown submission command: ${command ?? '(none)'}`);
  process.exit(2);
}

const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invoked) main();
