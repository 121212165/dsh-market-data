/** Best-effort repair after overlapping seed runs: regenerate the canonical
 * 25 plugins / 6 groups from catalog.source.json using the same mapping as
 * scripts/seed.mjs, and remove the extra entities introduced by my scratch
 * seed. Idempotent; does not touch any entity outside that known set. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(root, 'scripts', 'catalog.source.json'), 'utf8'));
const NAMES = {
  'dsh-plugin-transcript': '会话转录', 'dsh-plugin-transcript-search': '转录检索',
  'dsh-plugin-obsidian-push': 'Obsidian 推送', 'dsh-plugin-html-report': 'HTML 报告',
  'dsh-plugin-session-insights': '会话洞察', 'dsh-plugin-pinboard': '钉板',
  'dsh-plugin-fact-vault': '事实库', 'dsh-plugin-prompt-vault': '提示词库',
  'dsh-plugin-quota': '用量仪表', 'dsh-plugin-cost-ledger': '成本台账',
  'dsh-plugin-relay-quota': '中转额度', 'dsh-plugin-spend-forecast': '花费预测',
  'dsh-plugin-price-aware': '价格感知', 'dsh-plugin-token-telemetry': 'Token 遥测',
  'dsh-plugin-tool-trace': '工具追踪', 'dsh-plugin-error-radar': '错误雷达',
  'dsh-plugin-cache-guard': '缓存护栏', 'dsh-plugin-prompt-optimize': '提示词优化',
  'dsh-plugin-deep-scan': '深度扫描', 'dsh-plugin-eco-scan': '生态扫描',
  'dsh-plugin-local-deep-search': '本地深搜', 'dsh-plugin-task-forge': '任务工坊',
  'dsh-plugin-ide-hub': 'IDE 中枢', 'dsh-plugin-family-cards': '家族卡片',
  'dsh-plugin-plugin-forge': '插件锻造',
};
const REQUIRES = {
  '会话与知识库': ['tools', 'sessionProjections'], '钱与用量': ['tools', 'systemPrompt', 'sessionProjections'],
  '工具与质量': ['tools', 'llmMiddleware'], '扫描与研究': ['tools'],
  '编排与界面': ['tools', 'systemPrompt'], '构建与开发工具': ['tools'],
};
const entriesOf = (source, id) => {
  const ticks = [...String(source ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const unique = [...new Set(ticks.filter(Boolean))];
  return unique.length ? unique : [`/${id.replace(/^dsh-plugin-/, '')}`];
};
const canonical = new Set();
for (const entry of catalog.plugins.filter((item) => item.listed !== false)) {
  const id = entry.repo;
  canonical.add(id);
  const plugin = {
    id, repo: `121212165/${id}`, npm: `@deepseek-ai/${id}`,
    name: NAMES[id] ?? id.replace(/^dsh-plugin-/, ''),
    oneLiner: entry.featuredBlurb ?? entry.blurb, category: entry.category,
    entries: entriesOf(entry.featuredEntries ?? entry.entries, id),
    requires: REQUIRES[entry.category] ?? ['tools'],
    dshRange: '>=0.1.2-rc.1 <0.2.0', license: 'MIT', author: '121212165',
    borrowedFrom: [], verifiedAt: catalog.fetchedAt ?? '2026-11-21',
  };
  writeFileSync(join(root, 'data', 'plugins', `${id}.json`), JSON.stringify(plugin, null, 2) + '\n', 'utf8');
}
// Groups: keep the existing six canonical group files (untouched by the scratch seed).
const scratchPlugins = [
  'dsh-plugin-market', 'dsh-plugin-web-search', 'dsh-plugin-cron-reminder', 'dsh-plugin-git-helper',
  'dsh-plugin-doc-writer', 'dsh-plugin-context-guard', 'dsh-plugin-mcp-bridge', 'dsh-plugin-session-backup',
];
const scratchGroups = ['save-money', 'handoff'];
for (const id of [...scratchPlugins.map((name) => ['plugins', name]), ...scratchGroups.map((name) => ['groups', name])]) {
  const path = join(root, 'data', id[0], `${id[1]}.json`);
  if (existsSync(path)) unlinkSync(path);
}
console.log(`repaired ${canonical.size} canonical plugins; removed ${scratchPlugins.length + scratchGroups.length} scratch entities`);
