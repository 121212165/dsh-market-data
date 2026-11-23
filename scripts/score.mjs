/** F8 — explainable contribution score.
 *
 *  贡献分 = 收录 + 被组合 + 被融合 + 有效票 = Σ(分项数量 × 公开权重)
 *
 * The weights live in schema/score.weights.json (single source of truth); this
 * module never hard-codes a number. Every component carries its source ids, so
 * any entry can answer "分从哪来" without reading the implementation.
 *
 * Inputs are consumed, not produced: groups come from F1/F7 data, votes from
 * the F2 snapshot (data/votes.json), fusions from the F3 event snapshot
 * (data/fusions.json; a marked fixture placeholder until F3 merges).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountAgeDays } from './vote-snapshot-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEIGHTS_FILE = join(ROOT, 'schema', 'score.weights.json');
export const FUSIONS_FILE = join(ROOT, 'data', 'fusions.json');

export const COMPONENTS = ['included', 'grouped', 'fused', 'validVotes'];
const FALLBACK_LABELS = {
  included: '收录', grouped: '被组合', fused: '被融合', validVotes: '有效票',
};

/** Load the public weights contract. `points` accepts either a number or
 *  `{ points, label, description }`; missing labels fall back to Chinese names. */
export function loadWeights(file = WEIGHTS_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const weights = {};
  for (const key of COMPONENTS) {
    const def = raw.weights?.[key];
    const points = typeof def === 'number' ? def : def?.points;
    if (!Number.isFinite(points) || points < 0) {
      throw new Error(`score.weights.json: 权重 ${key} 必须是非负数字`);
    }
    weights[key] = {
      points,
      label: (typeof def === 'object' && def.label) || FALLBACK_LABELS[key],
      description: (typeof def === 'object' && def.description) || '',
    };
  }
  return {
    version: raw.schemaVersion ?? raw.version ?? 1,
    weights,
    antiGaming: {
      oneVotePerAccount: raw.antiGaming?.oneVotePerAccount ?? true,
      accountAgeDaysMin: raw.antiGaming?.accountAgeDaysMin ?? 30,
      duplicateVotesExcluded: raw.antiGaming?.duplicateVotesExcluded ?? true,
      rawReactionsIgnored: raw.antiGaming?.rawReactionsIgnored ?? true,
      note: raw.antiGaming?.note ?? '',
    },
    source: raw,
  };
}

/** Re-apply F2's anti-gaming rules to one vote entry.
 *  One person one vote (by id, then login) + account-age threshold. The F2
 *  `votes` number is authoritative but is capped by the deduped valid voters,
 *  so a tampered snapshot can never inflate 有效票 (刷票降权). */
export function effectiveVotes(entry = {}, { minAccountAgeDays = 30, now } = {}) {
  const recorded = Math.max(0, Number(entry?.votes) || 0);
  const seen = new Set();
  const validVoterIds = [];
  let duplicates = 0;
  let underAge = 0;
  let invalid = 0;

  const voters = Array.isArray(entry?.voters) ? entry.voters : null;
  if (voters) {
    for (const voter of voters) {
      const key = voter?.id
        ? `id:${String(voter.id)}`
        : `login:${String(voter?.login ?? '').toLowerCase()}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      if (!voter?.createdAt) { invalid++; continue; }
      const age = accountAgeDays(voter, now);
      if (age === null) { invalid++; continue; }
      if (age < minAccountAgeDays) { underAge++; continue; }
      validVoterIds.push(String(voter.id ?? voter.login));
    }
  }

  const count = voters ? Math.min(recorded, validVoterIds.length) : recorded;
  const fromSnapshot = entry?.excluded ?? {};
  const excluded = {
    duplicates: (fromSnapshot.duplicates ?? 0) + duplicates,
    underAge: (fromSnapshot.underAge ?? 0) + underAge,
    invalid: (fromSnapshot.invalid ?? 0) + invalid,
  };
  return { count, validVoterIds, excluded, recorded, rawReactions: entry?.rawReactions ?? null };
}

/** Score one plugin, with every component traceable to source ids. */
export function scorePlugin({ plugin, groups = [], fusions = null, votes = null, weights, now } = {}) {
  const w = weights ?? loadWeights();
  const threshold = votes?.accountAgeDaysMin ?? w.antiGaming.accountAgeDaysMin;
  const id = plugin.id;

  const included = [{ id, detail: `data/plugins/${id}.json` }];
  const grouped = [];
  for (const group of groups) {
    const index = (group.members ?? []).indexOf(id);
    if (index >= 0) {
      grouped.push({ id: group.id, detail: `${group.name ?? group.id} · members[${index}]` });
    }
  }
  const fused = [];
  for (const event of fusions?.events ?? []) {
    if ((event.sourcePluginIds ?? []).includes(id)) {
      fused.push({ id: event.id, detail: event.name ? `${event.name} · sourcePluginIds` : 'sourcePluginIds' });
    }
  }

  const entry = (votes?.entries ?? []).find((e) => e.pluginId === id) ?? null;
  const effective = effectiveVotes(entry, { minAccountAgeDays: threshold, now });
  let validSources = effective.validVoterIds.map((voterId) => {
    const voter = (entry?.voters ?? []).find((v) => String(v.id ?? v.login) === voterId);
    return { id: voterId, detail: voter?.login ? `${voter.login} · 👍` : 'F2 有效 👍' };
  });
  if (!validSources.length && effective.count > 0) {
    // Snapshot without a voter list: keep the count but make the source explicit.
    validSources = Array.from({ length: effective.count }, (_, i) => ({
      id: `valid-vote-${i + 1}`, detail: 'F2 有效票（未提供 voters 明细）',
    }));
  }

  const byKey = { included, grouped, fused, validVotes: validSources };
  const scoreBreakdown = COMPONENTS.map((key) => {
    const conf = w.weights[key];
    const sources = byKey[key];
    return {
      key,
      label: conf.label,
      weight: conf.points,
      count: sources.length,
      subtotal: sources.length * conf.points,
      sources,
      ...(key === 'validVotes' ? {
        excluded: effective.excluded,
        recordedVotes: effective.recorded,
        rawReactions: effective.rawReactions,
      } : {}),
    };
  });

  return {
    id,
    score: scoreBreakdown.reduce((sum, c) => sum + c.subtotal, 0),
    scoreBreakdown,
  };
}

/** Compute scores for every plugin in a built index. Returns Map<id, result>. */
export function computeScores({ plugins = [], groups = [], fusions = null, votes = null, weights, now } = {}) {
  const w = weights ?? loadWeights();
  return new Map(plugins.map((plugin) => [
    plugin.id,
    scorePlugin({ plugin, groups, fusions, votes, weights: w, now }),
  ]));
}

/** Attach `score` + `scoreBreakdown` to each plugin of a built index object. */
export function withScores(index, { fusions = null, votes = null, weights, now } = {}) {
  const scores = computeScores({
    plugins: index.plugins,
    groups: index.groups,
    fusions,
    votes,
    weights,
    now,
  });
  return {
    ...index,
    plugins: index.plugins.map((plugin) => {
      const { score, scoreBreakdown } = scores.get(plugin.id);
      return { ...plugin, score, scoreBreakdown };
    }),
  };
}

/** Human-readable "分从哪来" line set, used by reports and tests. */
export function explainScore(entry) {
  const lines = [`贡献分 ${entry.score}`];
  for (const component of entry.scoreBreakdown ?? []) {
    const ids = component.sources.map((s) => s.id).join(', ') || '无';
    lines.push(`${component.label}: ${component.count} × ${component.weight} = ${component.subtotal}（来源 ${ids}）`);
  }
  return lines.join('\n');
}
