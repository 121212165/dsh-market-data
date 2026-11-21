/**
 * M4 verification (Node, zero deps). Evidence -> m4-report.json.
 *   1. placeholder-only PR is rejected by the same gate the Action runs
 *   2. index.json -> site/index.html sync (deterministic rebuild + embedded sha)
 *   3. every group exposes a copyable `/market install <id>` command
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEntry } from './check-pr.mjs';
import { renderHtml, normalizeIndex, buildSite } from './build-site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const errors = [];
const criteria = {};

/* 1 — placeholder PR gate ------------------------------------------------ */
const placeholder = JSON.parse(read('test/fixtures/bad/groups/placeholder-only.json'));
const placeholderErrors = checkEntry('test/fixtures/bad/groups/placeholder-only.json', placeholder);
const placeholderCodes = placeholderErrors.map((e) => e.code);
criteria.placeholderPrRejected = placeholderErrors.length > 0 && placeholderCodes.includes('PLACEHOLDER_FIELD');
if (!criteria.placeholderPrRejected) errors.push('placeholder-only PR was not rejected');

const good = JSON.parse(read('data/groups/archive-chain.json'));
const goodErrors = checkEntry('data/groups/archive-chain.json', good);
criteria.goodGroupAccepted = goodErrors.length === 0;
if (!criteria.goodGroupAccepted) errors.push(`good group rejected: ${JSON.stringify(goodErrors)}`);

/* 2 — index -> page sync ------------------------------------------------- */
// Rebuild first so a concurrently-updated index.json can never make the check
// look stale; determinism is proven by comparing two independent renderings.
buildSite();
const raw = read('data/index.json');
const sha = createHash('sha256').update(raw).digest('hex');
const index = normalizeIndex(JSON.parse(raw));
const expectedHtml = renderHtml(JSON.parse(raw), { sourceSha256: sha, builtAt: index.generatedAt });
const actualHtml = read('site/index.html');
criteria.siteRebuildIsByteIdentical = expectedHtml === actualHtml;
if (!criteria.siteRebuildIsByteIdentical) errors.push('site/index.html is stale vs data/index.json');

const shaInHtml = (actualHtml.match(/data-index-sha256="([a-f0-9]+)"/) || [])[1];
criteria.shaMatchesIndex = shaInHtml === sha;
if (!criteria.shaMatchesIndex) errors.push(`embedded sha ${shaInHtml} != index sha ${sha}`);

const embedded = JSON.parse((actualHtml.match(/<script id="market-data" type="application\/json">([\s\S]*?)<\/script>/) || [])[1] || '{}');
const embeddedIndex = normalizeIndex(embedded);
const ids = (xs) => xs.map((x) => x.id).sort();
criteria.embeddedDataMatchesIndex =
  embeddedIndex.generatedAt === index.generatedAt &&
  JSON.stringify(ids(embeddedIndex.plugins)) === JSON.stringify(ids(index.plugins)) &&
  JSON.stringify(ids(embeddedIndex.groups)) === JSON.stringify(ids(index.groups));
if (!criteria.embeddedDataMatchesIndex) errors.push('embedded page data differs from index.json');

/* 3 — copyable install command ------------------------------------------ */
const missingCopy = index.groups.filter((g) => !actualHtml.includes(`data-copy-install="/market install ${g.id}"`));
criteria.copyCommandPresentForEveryGroup = missingCopy.length === 0;
if (!criteria.copyCommandPresentForEveryGroup) errors.push(`missing copy button for: ${missingCopy.map((g) => g.id).join(', ')}`);
criteria.clipboardHandlerPresent = /navigator\.clipboard\.writeText\(cmd\)/.test(actualHtml);
if (!criteria.clipboardHandlerPresent) errors.push('no clipboard.writeText handler in page script');

const report = {
  milestone: 'M4',
  generatedAt: new Date().toISOString(),
  index: { sha256: sha, generatedAt: index.generatedAt, plugins: index.plugins.length, groups: index.groups.length },
  placeholderPr: { codes: [...new Set(placeholderCodes)] },
  criteria,
  errors,
  pass: errors.length === 0,
};
writeFileSync(join(ROOT, 'm4-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(criteria, null, 2));
console.log(report.pass ? 'PASS' : `FAIL: ${errors.join('; ')}`);
process.exit(report.pass ? 0 : 1);
