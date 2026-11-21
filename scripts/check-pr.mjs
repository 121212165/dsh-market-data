/**
 * M4 PR gate (Action: market-gate.yml).
 *
 * Self-contained on purpose: it does not import the mutable data-layer validator.
 * Given a list of changed JSON files (git diff --name-only, or all of data/ when
 * run locally), it rejects:
 *   1. placeholder-only fields (TODO / 待补 / 应该能用 / TBD ...)  -> PLACEHOLDER_FIELD
 *   2. a group whose `why` cites no concrete handshake contract   -> WHY_NO_CONTRACT
 *   3. a group whose `verify` is vague ("应该能用")               -> VAGUE_VERIFY
 *   4. malformed JSON / non-object entries                        -> BAD_SHAPE
 *
 * Exit 1 with a JSON report on stdout so the Action log is machine-readable.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PLACEHOLDER_RE = /^(?:todo|tbd|fixme|xxx+|placeholder|lorem(?: ipsum)?|待补|待定|占位|占位符|示例|sample|test|foo|bar|n\/?a|无|-+|TODO\s*TODO)$/i;
const VAGUE_RE = /^(?:应该能用|应该可以|应该没问题|大概能|待验证|待定|maybe|possibly|probably|ok|pass|TODO|TBD)$/i;
const CONTRACT_RE = /\.json\b|\.jsonl\b|\.md\b|\.mjs\b|\bJSONL\b|\/[a-z][a-z0-9-]*\b|[A-Za-z_]+\.[A-Za-z_]+|\b(?:字段|台账|契约|预算|出处|燃烧率|命中率|repo\s*id|per-call|summary|token)\b/i;

const norm = (v) => typeof v === 'string' ? v.trim().replace(/^[\s\-_:：]+|[\s\-_:：]+$/g, '') : '';
const isPlaceholder = (v) => PLACEHOLDER_RE.test(norm(v)) || /^(?:todo|tbd|待补|占位|占位符).{0,10}$/i.test(norm(v));

export function checkEntry(file, data) {
  const errors = [];
  const add = (code, detail) => errors.push({ file, code, detail });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    add('BAD_SHAPE', 'entry must be a JSON object');
    return errors;
  }
  const isGroup = Array.isArray(data.members) && 'why' in data;
  const textFields = isGroup
    ? ['id', 'name', 'oneLiner', 'installOrder']
    : ['id', 'repo', 'name', 'oneLiner', 'category', 'dshRange', 'license', 'author', 'verifiedAt'];
  for (const key of textFields) {
    if (key in data && isPlaceholder(data[key])) add('PLACEHOLDER_FIELD', `\`${key}\` = ${JSON.stringify(data[key])}`);
  }
  if (isGroup) {
    for (const key of ['why', 'verify']) {
      if (Array.isArray(data[key])) {
        data[key].forEach((line, i) => {
          if (isPlaceholder(line)) add('PLACEHOLDER_FIELD', `${key}[${i}] = ${JSON.stringify(line)}`);
        });
      }
    }
    if (!Array.isArray(data.why) || data.why.length === 0) add('GROUP_MISSING_WHY', 'a group with no why is a marketing bundle');
    else if (!data.why.some((line) => CONTRACT_RE.test(String(line)))) add('WHY_NO_CONTRACT', 'no why line cites a real handshake contract');
    if (!Array.isArray(data.verify) || data.verify.length === 0) add('GROUP_MISSING_VERIFY', 'verify must be executable');
    else data.verify.forEach((line, i) => { if (VAGUE_RE.test(norm(line))) add('VAGUE_VERIFY', `verify[${i}] = ${JSON.stringify(line)}`); });
  }
  return errors;
}

export function checkFiles(files, root = ROOT) {
  const errors = [];
  for (const rel of files) {
    const abs = resolve(root, rel);
    if (!abs.startsWith(root) || !abs.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(readFileSync(abs, 'utf8')); }
    catch (err) { errors.push({ file: rel, code: 'BAD_JSON', detail: err.message }); continue; }
    errors.push(...checkEntry(rel, data));
  }
  return errors;
}

function changedFilesFromGit() {
  try {
    const base = process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : 'HEAD~1';
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = args.length ? args : changedFilesFromGit();
  const errors = checkFiles(files);
  const report = {
    ok: errors.length === 0,
    filesChecked: files.length,
    errors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(errors.length ? 1 : 0);
}

const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invoked) main();
