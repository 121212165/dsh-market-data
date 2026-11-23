/**
 * Offline validation of the market dataset.
 *
 * - Structural checks reuse scripts/lib.mjs `validateSchema` against schema/*.json
 *   (the zero-dependency draft-2020-12 subset from the M0 foundation).
 * - Semantic checks cover the three M0 bad samples (duplicate id, dead repo,
 *   missing/placeholder `why`) plus the group red line from plan §4.2.
 * - `checkReposOnline` adds real GitHub 404 detection when `--online` is passed.
 *
 * Exports pure helpers so tests can feed fixtures without touching the network.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRepo, validateSchema, isIsomorphic, mapLimit } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLUGIN_ID_RE = /^dsh-plugin-[a-z0-9-]+$/;
const GROUP_ID_RE = /^[a-z0-9-]+$/;
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);
const ALLOWED_CURATORS = new Set(['editor', 'community']);
const CONTRACT_RE = /\.json\b|\.jsonl\b|\.md\b|\.mjs\b|\bJSONL\b|\/[a-z][a-z0-9-]*\b|[A-Za-z_]+\.[A-Za-z_]+|\b(?:字段|台账|契约|预算|出处|燃烧率|命中率|repo\s*id|per-call|summary|token)\b/i;
const PLACEHOLDER_RE = /\b(?:TODO|TBD|待补|待写|应该能用|占位|placeholder)\b/i;
/** Known-dead repos plus obviously fake slugs used by the offline fixtures. */
const DEAD_REPOS = new Set(['121212165/dsh-plugin-dead-link', 'example/gone']);
const OBVIOUSLY_DEAD_RE = /does-not-exist|not-exist|doesnt-exist|404|dead-link/i;

/**
 * Classify a human-readable validation message into a stable machine code.
 * Kept separate from `validateDataset` so the exported API (an array of
 * human-readable strings) stays backwards-compatible while `--json` callers
 * get structured error codes.
 */
export function classifyValidationError(message) {
  const text = String(message);
  if (/\bduplicate-id\b/.test(text)) return 'DUPLICATE_PLUGIN_ID';
  if (/\bdead-repo\b/.test(text)) return 'DEAD_REPO';
  if (/\bunknown-member\b/.test(text)) return 'UNKNOWN_MEMBER';
  if (/\bplaceholder\b/i.test(text)) return 'PLACEHOLDER_FIELD';
  if (/\bwhy\b/.test(text) && /\bempty\b/.test(text)) return 'GROUP_MISSING_WHY';
  if (/\bwhy\b/.test(text)) return 'GROUP_MISSING_WHY';
  if (/\bschema\b/.test(text)) return 'SCHEMA_INVALID';
  if (/shape/.test(text)) return 'SHAPE_MISMATCH';
  if (/count/.test(text)) return 'COUNT_MISMATCH';
  if (/\bverifiedAt\b|\bupdatedAt\b/.test(text)) return 'BAD_DATE';
  return 'VALIDATION_ERROR';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isStringArray(value, { min = 0 } = {}) {
  return Array.isArray(value) && value.length >= min && value.every(isNonEmptyString);
}

/**
 * @param {object} input
 * @param {Array<{file:string,data:unknown}>} input.plugins
 * @param {Array<{file:string,data:unknown}>} input.groups
 * @param {string[]} [input.categories]
 * @param {{plugin?:object,group?:object}} [input.schemas]
 * @returns {string[]} human-readable errors (empty = green)
 */
export function validateDataset({ plugins, groups, categories = [], schemas = {} }) {
  const errors = [];
  const push = (file, rule, detail) => errors.push(`${file}: ${rule} — ${detail}`);
  const schemaErrors = (file, data, schema) => {
    if (!schema) return;
    for (const message of validateSchema(data, schema, file)) errors.push(`${message} [schema]`);
  };

  const seenPluginIds = new Map();
  const pluginById = new Map();

  for (const { file, data } of plugins) {
    if (!isObject(data)) {
      push(file, 'shape', 'plugin entry must be an object');
      continue;
    }
    schemaErrors(file, data, schemas.plugin);
    for (const key of ['id', 'repo', 'name', 'oneLiner', 'category', 'entries', 'requires', 'dshRange', 'license', 'author', 'borrowedFrom', 'verifiedAt']) {
      if (!(key in data)) push(file, 'required', `missing field \`${key}\``);
    }
    if (!isNonEmptyString(data.id)) push(file, 'id', 'must be a non-empty string');
    else if (!PLUGIN_ID_RE.test(data.id)) push(file, 'id', `bad id \`${data.id}\` (expected dsh-plugin-*)`);
    else {
      if (seenPluginIds.has(data.id)) push(file, 'duplicate-id', `also used by ${seenPluginIds.get(data.id)}`);
      else seenPluginIds.set(data.id, file);
      pluginById.set(data.id, data);
      if (file && !file.replace(/\\/g, '/').endsWith(`${data.id}.json`)) push(file, 'filename', `filename must match id \`${data.id}.json\``);
    }
    if (!isNonEmptyString(data.repo) || !REPO_RE.test(data.repo)) push(file, 'repo', `bad repo \`${String(data.repo)}\` (expected owner/name)`);
    else if (DEAD_REPOS.has(data.repo) || OBVIOUSLY_DEAD_RE.test(data.repo)) push(file, 'dead-repo', `\`${data.repo}\` looks like a dead link (offline check; use --online to confirm 404)`);
    if (!ALLOWED_LICENSES.has(data.license)) push(file, 'license', `\`${String(data.license)}\` not in allow-list (fusion pool requires MIT/Apache-2.0)`);
    if (data.category !== undefined && !isNonEmptyString(data.category)) push(file, 'category', 'must be a non-empty string');
    else if (categories.length && !categories.includes(data.category)) push(file, 'category', `\`${String(data.category)}\` not in categories.json`);
    if (!isStringArray(data.entries, { min: 1 })) push(file, 'entries', 'must be a non-empty string array');
    if (!isStringArray(data.requires)) push(file, 'requires', 'must be a string array');
    if (!isStringArray(data.borrowedFrom)) push(file, 'borrowedFrom', 'must be a string array');
    if (!isNonEmptyString(data.dshRange)) push(file, 'dshRange', 'must be a non-empty string');
    if (!isNonEmptyString(data.name) || !isNonEmptyString(data.oneLiner)) push(file, 'display', 'name and oneLiner must be non-empty');
    if (typeof data.verifiedAt === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(data.verifiedAt)) push(file, 'verifiedAt', 'expected YYYY-MM-DD');
  }

  const seenGroupIds = new Map();
  for (const { file, data } of groups) {
    if (!isObject(data)) {
      push(file, 'shape', 'group entry must be an object');
      continue;
    }
    schemaErrors(file, data, schemas.group);
    for (const key of ['id', 'name', 'oneLiner', 'members', 'why', 'installOrder', 'conflicts', 'verify', 'curator', 'updatedAt']) {
      if (!(key in data)) push(file, 'required', `missing field \`${key}\``);
    }
    if (!isNonEmptyString(data.id)) push(file, 'id', 'must be a non-empty string');
    else if (!GROUP_ID_RE.test(data.id)) push(file, 'id', `bad id \`${data.id}\``);
    else {
      if (seenGroupIds.has(data.id)) push(file, 'duplicate-id', `also used by ${seenGroupIds.get(data.id)}`);
      else seenGroupIds.set(data.id, file);
      if (file && !file.replace(/\\/g, '/').endsWith(`${data.id}.json`)) push(file, 'filename', `filename must match id \`${data.id}.json\``);
    }
    if (!isStringArray(data.members, { min: 1 })) push(file, 'members', 'must be a non-empty string array');
    else for (const member of data.members) {
      if (!pluginById.has(member)) push(file, 'unknown-member', `\`${member}\` is not in data/plugins`);
    }
    if (!isStringArray(data.why, { min: 1 })) push(file, 'why', 'missing or empty — a group with no real handshake contract is a marketing bundle and must not ship');
    else {
      if (!data.why.some((line) => CONTRACT_RE.test(line))) push(file, 'why', 'no line cites a concrete handshake contract (file/field/command/JSON key)');
      if (data.why.some((line) => PLACEHOLDER_RE.test(line))) push(file, 'why', 'placeholder text found — write the real handshake contract');
    }
    if (!isStringArray(data.verify, { min: 1 })) push(file, 'verify', 'missing or empty — verify steps must be executable, not "should work"');
    else if (data.verify.some((line) => PLACEHOLDER_RE.test(line) || /应该|大概|可能/.test(line))) push(file, 'verify', 'non-executable placeholder in verify steps');
    if (!isNonEmptyString(data.installOrder) || PLACEHOLDER_RE.test(data.installOrder)) push(file, 'installOrder', 'must be a concrete string (no TODO/TBD)');
    if (!isStringArray(data.conflicts)) push(file, 'conflicts', 'must be a string array');
    if (!ALLOWED_CURATORS.has(data.curator)) push(file, 'curator', `\`${String(data.curator)}\` must be editor|community`);
    if (typeof data.updatedAt === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt)) push(file, 'updatedAt', 'expected YYYY-MM-DD');
    if (!isNonEmptyString(data.name) || PLACEHOLDER_RE.test(data.name)) push(file, 'name', 'must be a concrete name (no TODO/placeholder)');
    if (!isNonEmptyString(data.oneLiner)) push(file, 'oneLiner', 'must be non-empty');
  }

  return errors;
}

/** Optional network liveness check; never part of the offline gate. */
export async function checkReposOnline(plugins, limit = 8) {
  const targets = plugins.filter(({ data }) => isObject(data) && isNonEmptyString(data.repo));
  const checked = await mapLimit(targets, limit, async ({ file, data }) => {
    const result = await checkRepo(data.repo);
    // status 0 = 网络不可达/超时，只能标记"无法校验"，不能当成死链误报。
    if (result.status === 0) {
      console.warn(`  ! repo 无法校验（网络不可达）: ${data.repo}`);
      return null;
    }
    return result.ok ? null
      : `${file}: dead-repo — ${data.repo} returned ${result.status}`;
  });
  return checked.filter(Boolean);
}

function readDir(folder) {
  const dir = join(root, 'data', folder);
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((name) => ({
    file: `data/${folder}/${name}`,
    data: JSON.parse(readFileSync(join(dir, name), 'utf8')),
  }));
}

function loadSchemas() {
  const load = (name) => JSON.parse(readFileSync(join(root, 'schema', `${name}.schema.json`), 'utf8'));
  try {
    return { plugin: load('plugin'), group: load('group') };
  } catch {
    return {};
  }
}

function readCategories() {
  try {
    return JSON.parse(readFileSync(join(root, 'data', 'categories.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** Parse CLI flags. `--extra <path>` may be repeated; it injects one fixture
 * (a plugin or group JSON) into the corresponding validation set. */
function parseArgs(argv) {
  const args = { json: false, online: false, extras: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--online') args.online = true;
    else if (token === '--offline') { /* offline is the default */ }
    else if (token === '--extra') {
      const file = argv[++i];
      if (file) args.extras.push(file);
    } else if (token.startsWith('--extra=')) {
      args.extras.push(token.slice('--extra='.length));
    }
  }
  return args;
}

function readExtra(folder, file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return { file, data, folder };
}

/** Structured report shared by `--json` output and programmatic callers. */
function buildReport(errors, plugins, groups, onlineErrors = []) {
  const all = [...errors, ...onlineErrors];
  return {
    ok: all.length === 0,
    counts: { plugins: plugins.length, groups: groups.length, errors: all.length },
    errors: all.map((message, index) => {
      const text = String(message);
      const match = text.match(/^(.*?):\s*([^—]+?)\s*—\s*(.*)$/s);
      return {
        code: classifyValidationError(text),
        index,
        file: match ? match[1] : '',
        rule: match ? match[2].trim() : '',
        detail: match ? match[3].trim() : text,
        message: text,
      };
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const online = args.online;
  const plugins = readDir('plugins');
  const groups = readDir('groups');
  for (const file of args.extras) {
    const normalized = file.replace(/\\/g, '/');
    const folder = /(^|\/)plugins\//.test(normalized) ? 'plugins'
      : /(^|\/)groups\//.test(normalized) ? 'groups' : null;
    if (!folder) {
      console.error(`validate: --extra path must sit under plugins/ or groups/: ${file}`);
      process.exit(2);
    }
    const entry = readExtra(folder, file);
    (folder === 'plugins' ? plugins : groups).push(entry);
  }
  const onDiskPlugins = plugins.length;
  const onDiskGroups = groups.length;
  const errors = validateDataset({ plugins, groups, categories: readCategories(), schemas: loadSchemas() });

  // F2: a committed vote snapshot must satisfy its contract, reference only
  // known plugin ids, and keep the summary in sync with the per-entry counts.
  const votesFile = join(root, 'data', 'votes.json');
  if (existsSync(votesFile)) {
    try {
      const votes = JSON.parse(readFileSync(votesFile, 'utf8'));
      const votesSchema = JSON.parse(readFileSync(join(root, 'schema', 'votes.schema.json'), 'utf8'));
      for (const message of validateSchema(votes, votesSchema, 'data/votes.json')) errors.push(message);
      const pluginIds = new Set(plugins.map(({ data }) => data?.id));
      for (const entry of votes.entries ?? []) {
        if (!pluginIds.has(entry.pluginId)) {
          errors.push(`data/votes.json: orphan-vote — ${entry.pluginId} is not in data/plugins`);
        }
      }
      const sum = (votes.entries ?? []).reduce((n, entry) => n + (entry.votes ?? 0), 0);
      if (votes.summary && sum !== votes.summary.countedVotes) {
        errors.push(`data/votes.json: summary — countedVotes(${votes.summary.countedVotes}) != entries sum(${sum})`);
      }
    } catch (error) {
      errors.push(`data/votes.json: ${error.message}`);
    }
  }

  // M0 验收：snapshot 与 index 必须同构，且 index 覆盖全部 seed 实体。
  // `--extra` fixtures are deliberately excluded from this count check.
  try {
    const idx = JSON.parse(readFileSync(join(root, 'data', 'index.json'), 'utf8'));
    const snap = JSON.parse(readFileSync(join(root, 'data', 'snapshot.json'), 'utf8'));
    if (!isIsomorphic(idx, snap)) {
      errors.push('snapshot.json: shape — snapshot 与 index.json 结构不同构 (M0 验收)');
    }
    if (idx.plugins?.length !== onDiskPlugins || idx.groups?.length !== onDiskGroups) {
      errors.push(`index.json: count — index(${idx.plugins?.length}/${idx.groups?.length}) 与 data/(${onDiskPlugins}/${onDiskGroups}) 不一致`);
    }
  } catch (error) {
    errors.push(`index/snapshot: ${error.message}`);
  }

  let onlineErrors = [];
  if (online) {
    const liveErrors = await checkReposOnline(plugins);
    let knownDead = [];
    try {
      knownDead = JSON.parse(readFileSync(join(root, 'data', 'liveness.json'), 'utf8')).knownDead || [];
    } catch { /* liveness.json 可选 */ }
    for (const message of liveErrors) {
      if (knownDead.some((slug) => message.includes(slug))) {
        console.warn(`  ! known-dead (F7 将降权): ${message}`);
      } else {
        onlineErrors.push(message);
      }
    }
  }

  const report = buildReport(errors, plugins, groups, onlineErrors);
  if (args.json) {
    // Important: stdout carries ONLY the JSON document; all human diagnostics
    // go to stderr. Callers can parse stdout unconditionally in this mode.
    console.log(JSON.stringify(report));
    process.exit(report.ok ? 0 : 1);
  }
  if (!report.ok) {
    console.error(`validate: ${report.counts.errors} error(s)`);
    for (const error of report.errors) console.error(`  ✗ ${error.message}`);
    process.exit(1);
  }
  console.log(`validate: green — ${plugins.length} plugins, ${groups.length} groups pass all offline rules`);
  if (online) console.log('  (online repo liveness also green)');
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
