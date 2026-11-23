/** Rebuild the read contract from one-file-per-entity sources.
 *  index.json / snapshot.json / dsh-plugin-market/src/snapshot.json are written
 *  from the SAME object, so they are structurally identical (M0: 同构).
 *
 *  F8: after F7 governance, each plugin also gets `score` + `scoreBreakdown`,
 *  computed from the public weights in schema/score.weights.json. */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';
import { buildIndex } from './build-index-lib.mjs';
import { readSnapshot } from './snapshot.mjs';
import { loadWeights, withScores, WEIGHTS_FILE, FUSIONS_FILE } from './score.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readDir = (name) => readdirSync(join(root, 'data', name))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(root, 'data', name, file), 'utf8')));

const opts = parseArgs(process.argv.slice(2));

// F2: the vote snapshot (when present) is the single source of both the per-
// plugin `votes` field and the index generatedAt. Re-running the snapshot moves
// both together, so a stale page can be detected by the 24h rule (§5.1).
const votesFile = join(root, 'data', 'votes.json');
const votes = existsSync(votesFile) ? JSON.parse(readFileSync(votesFile, 'utf8')) : null;

// F7: latest.json is a stable pointer to the newest daily snapshot. Missing or
// corrupt data must never break the build — governance is simply skipped.
const snapshotFile = opts.snapshot
  ? (isAbsolute(String(opts.snapshot)) ? String(opts.snapshot) : join(root, String(opts.snapshot)))
  : join(root, 'data', 'snapshots', 'latest.json');
const snapshot = readSnapshot(snapshotFile);

// F8: public weights are the single source of truth; F3 fusion events are
// consumed as a snapshot (fixture placeholder until F3 merges).
const weights = loadWeights(WEIGHTS_FILE);
const fusions = existsSync(FUSIONS_FILE) ? JSON.parse(readFileSync(FUSIONS_FILE, 'utf8')) : null;

const built = buildIndex({
  plugins: readDir('plugins'),
  groups: readDir('groups'),
  votes,
  snapshot,
  now: typeof opts.now === 'string' && opts.now ? opts.now : undefined,
});
const index = withScores(built, {
  fusions,
  votes,
  weights,
  now: votes?.generatedAt,
});

const write = (target) => {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(index, null, 2) + '\n', 'utf8');
};

write(join(root, 'data', 'index.json'));
write(join(root, 'data', 'snapshot.json'));
const embedded = join(root, '..', 'dsh-plugin-market', 'src', 'snapshot.json');
if (existsSync(dirname(embedded))) write(embedded);

const demoted = index.plugins.filter((p) => p.demotionReason);
const stale = index.plugins.filter((p) => p.staleReason);
const w = weights.weights;
console.log(`index.json: ${index.plugins.length} plugins, ${index.groups.length} groups, ${index.generatedAt}`);
console.log(votes
  ? `votes: ${votes.summary?.countedVotes ?? 0} valid from ${votes.summary?.discussions ?? 0} Discussions (snapshot ${votes.generatedAt})`
  : 'votes: no data/votes.json yet — run scripts/vote-snapshot.mjs first');
console.log(snapshot
  ? `governance: ${demoted.length} demoted, ${stale.length} stale (metrics ${snapshot.date}, ${snapshot.source})`
  : 'governance: no snapshot — demotion skipped (fail-safe)');
console.log(`score: weights v${weights.version} from schema/score.weights.json (收录 ${w.included.points} · 被组合 ${w.grouped.points} · 被融合 ${w.fused.points} · 有效票 ${w.validVotes.points})`);
console.log(fusions?.status === 'fixture-placeholder'
  ? 'fused: F3 未合并，使用 fixture 占位事件（见 data/fusions.json）'
  : `fused: ${fusions?.events?.length ?? 0} events from F3 snapshot`);
console.log('snapshot.json + dsh-plugin-market/src/snapshot.json written from the same object (同构)');
