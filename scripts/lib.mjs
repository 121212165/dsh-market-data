import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SCHEMA_DIR = path.join(ROOT, 'schema');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: path.join(dir, f), name: f.replace(/\.json$/, '') }));
}

/* ------------------------------------------------------------------ *
 * Minimal JSON Schema validator (draft-2020-12 subset).
 * Supports: type, required, properties, additionalProperties,
 *           enum, pattern, minLength, minItems, maxItems, items.
 * Zero deps on purpose — this repo is read by CI on a bare runner.
 * ------------------------------------------------------------------ */
export function validateSchema(value, schema, at = '$') {
  const errors = [];
  const typeOf = (v) =>
    v === null ? 'null'
      : Array.isArray(v) ? 'array'
        : Number.isInteger(v) ? 'integer'
          : typeof v === 'number' ? 'number'
            : typeof v;

  const check = (v, s, p) => {
    if (!s || typeof s !== 'object') return;
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
      errors.push(`${p}: 不在允许枚举内 ${JSON.stringify(s.enum)} (实际 ${JSON.stringify(v)})`);
      return;
    }
    if (s.type) {
      const t = typeOf(v);
      const ok = s.type === 'number'
        ? (t === 'number' || t === 'integer')
        : s.type === 'integer' ? t === 'integer' : t === s.type;
      if (!ok) {
        errors.push(`${p}: 类型应为 ${s.type}，实际 ${t}`);
        return;
      }
    }
    if (typeof v === 'string') {
      if (s.minLength != null && v.length < s.minLength) errors.push(`${p}: 太短 (min ${s.minLength})`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: 不匹配 ${s.pattern}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push(`${p}: 至少 ${s.minItems} 项，实际 ${v.length}`);
      if (s.maxItems != null && v.length > s.maxItems) errors.push(`${p}: 至多 ${s.maxItems} 项，实际 ${v.length}`);
      if (s.items) v.forEach((item, i) => check(item, s.items, `${p}[${i}]`));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const key of s.required || []) {
        if (!Object.prototype.hasOwnProperty.call(v, key)) errors.push(`${p}.${key}: 缺失必填字段`);
      }
      const props = s.properties || {};
      for (const [key, val] of Object.entries(v)) {
        if (props[key]) check(val, props[key], `${p}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${p}.${key}: 未声明的额外字段`);
      }
    }
  };

  check(value, schema, at);
  return errors;
}

/* ------------------------------------------------------------------ *
 * Structural fingerprint: keys (sorted) + value kinds, recursively.
 * Used to prove index.json and snapshot.json are 同构 (same shape),
 * ignoring scalar values such as generatedAt.
 * ------------------------------------------------------------------ */
export function structureOf(value) {
  if (Array.isArray(value)) {
    // Arrays are compared element-by-element (length must match too).
    return { __t: 'array', items: value.map(structureOf) };
  }
  if (value && typeof value === 'object') {
    const out = { __t: 'object', keys: Object.keys(value).sort() };
    for (const k of out.keys) out[k] = structureOf(value[k]);
    return out;
  }
  return { __t: value === null ? 'null' : typeof value };
}

export function isIsomorphic(a, b) {
  return JSON.stringify(structureOf(a)) === JSON.stringify(structureOf(b));
}

/* ------------------------------------------------------------------ *
 * Repo liveness: GitHub returns 404 for deleted repos, 200 for live.
 * Timeout keeps `npm run validate` bounded on flaky networks.
 * ------------------------------------------------------------------ */
export async function checkRepo(slug, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://github.com/${slug}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dsh-market-validator/0.1' },
    });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * tiny CLI arg parser: --key value / --flag / --key=value, plus -- extras
 * ------------------------------------------------------------------ */
export function parseArgs(argv) {
  const opts = { _: [], extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq !== -1) { opts[key] = a.slice(eq + 1); continue; }
    if (key === 'extra') { opts.extra.push(argv[++i]); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { opts[key] = next; i++; }
    else opts[key] = true;
  }
  return opts;
}
