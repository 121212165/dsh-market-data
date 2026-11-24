#!/usr/bin/env node
/** F8 static/fixture evidence generator. It never labels fixture votes as live. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const errors = [];
const indexRaw = readFileSync(join(ROOT, 'data/index.json'), 'utf8');
const index = JSON.parse(indexRaw);
const weights = readJson('schema/score.weights.json');
const votes = readJson('data/votes.json');
const fusions = readJson('data/fusions.json');
const html = readFileSync(join(ROOT, 'site/index.html'), 'utf8');
const indexSha = createHash('sha256').update(indexRaw).digest('hex');

const testResult = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
const testOutput = `${testResult.stdout ?? ''}\n${testResult.stderr ?? ''}`;
const metric = (name) => {
  const match = testOutput.match(new RegExp(`(?:#|ℹ)\\s*${name}\\s+(\\d+)`, 'i'));
  return match ? Number(match[1]) : null;
};
const tests = { tests: metric('tests'), pass: metric('pass'), fail: metric('fail'), exitCode: testResult.status };
if (testResult.error) errors.push(`node --test could not start: ${testResult.error.message}`);
if (testResult.status !== 0 || tests.fail !== 0 || tests.pass === null) {
  errors.push(`node --test failed or its result could not be parsed: ${JSON.stringify(tests)}`);
}

const expectedKeys = Object.keys(weights.weights ?? {});
const breakdownIsComplete = (plugin) => {
  if (!Array.isArray(plugin.scoreBreakdown) || plugin.scoreBreakdown.length !== expectedKeys.length) return false;
  const keys = plugin.scoreBreakdown.map((item) => item.key);
  if (expectedKeys.some((key) => !keys.includes(key))) return false;
  const total = plugin.scoreBreakdown.reduce((sum, item) => {
    if (item.subtotal !== item.count * item.weight || !Array.isArray(item.sources) || item.sources.length !== item.count) return NaN;
    return sum + item.subtotal;
  }, 0);
  return Number.isFinite(total) && total === plugin.score;
};
const embeddedData = JSON.parse(html.match(/<script id="market-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? '{}');
const embeddedWeights = JSON.parse(html.match(/<script id="score-weights" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? '{}');
const voteEvidenceType = String(votes.source ?? '').startsWith('fixture:')
  ? 'fixture'
  : votes.source === 'discussions:reactions' ? 'live' : 'unverified';
const realFusion = fusions.status === 'f3-real' && fusions.events?.some((event) => event.id === 'fuse-quota-cost-ledger');

const criteria = {
  nodeTestGreen: testResult.status === 0 && tests.fail === 0 && tests.pass !== null,
  anyEntryHasCompleteBreakdown: index.plugins.length > 0 && index.plugins.every(breakdownIsComplete),
  pageExplainable: embeddedData.plugins?.length === index.plugins.length
    && embeddedData.plugins?.every((plugin) => breakdownIsComplete(plugin))
    && html.includes('data-index-sha256="'),
  weightsPublic: JSON.stringify(embeddedWeights) === JSON.stringify(weights),
  antiGamingReused: Number(votes.accountAgeDaysMin) === Number(weights.antiGaming?.accountAgeDaysMin)
    && votes.accountAgeDaysMin >= 30
    && weights.antiGaming?.oneVotePerAccount === true
    && weights.antiGaming?.duplicateVotesExcluded === true,
  realFusionSourcePresent: realFusion,
};
for (const [name, ok] of Object.entries(criteria)) if (!ok) errors.push(`F8 criterion failed: ${name}`);

const report = {
  milestone: 'F8',
  evidenceType: 'static',
  generatedAt: new Date().toISOString(),
  index: { evidenceType: 'static', sha256: indexSha, generatedAt: index.generatedAt, plugins: index.plugins.length },
  weights: { evidenceType: 'static', file: 'schema/score.weights.json', version: weights.schemaVersion, weights: weights.weights },
  voting: {
    evidenceType: voteEvidenceType,
    source: votes.source,
    accountAgeDaysMin: votes.accountAgeDaysMin,
    summary: votes.summary,
    liveGitHubValidation: 'unverified: target repository currently returns 404 and the data repository has no remote',
  },
  fusions: { evidenceType: 'static', status: fusions.status, realFusion },
  evidence: {
    nodeTest: { evidenceType: 'local-test', command: 'node --test', ...tests },
    artifacts: { evidenceType: 'static', index: 'data/index.json', site: 'site/index.html' },
  },
  criteria,
  errors,
  pass: Object.values(criteria).every(Boolean) && errors.length === 0,
  honesty: `本报告为本地静态验收；有效票来源类型=${voteEvidenceType}。没有将 fixture 票数描述为 GitHub live，目标仓 live 投票、Actions 与 Pages 均未验证。`,
};

writeFileSync(join(ROOT, 'f8-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(criteria, null, 2));
console.log(report.pass ? `PASS (${tests.pass}/${tests.tests} tests)` : `FAIL: ${errors.join('; ')}`);
process.exit(report.pass ? 0 : 1);
