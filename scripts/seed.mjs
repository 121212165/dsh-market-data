/**
 * Deterministic seed generator for dsh-market-data.
 * Plugins come from the canonical family catalog (scripts/catalog.source.json,
 * synced from dsh-plugin-family/catalog.json): 25 listed plugins, 6 categories.
 * Groups are the 6 curated bundles from section 4.3 of DSH-MARKET-PLAN.md;
 * IDs match the existing M3 conversation.view panel.
 * Re-running is idempotent.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(root, 'scripts', 'catalog.source.json'), 'utf8'));

/** Display names for the 25 listed plugins (catalog carries only repo + blurb). */
const NAMES = {
  'dsh-plugin-transcript': '会话转录',
  'dsh-plugin-transcript-search': '转录检索',
  'dsh-plugin-obsidian-push': 'Obsidian 推送',
  'dsh-plugin-html-report': 'HTML 报告',
  'dsh-plugin-session-insights': '会话洞察',
  'dsh-plugin-pinboard': '钉板',
  'dsh-plugin-fact-vault': '事实库',
  'dsh-plugin-prompt-vault': '提示词库',
  'dsh-plugin-quota': '用量仪表',
  'dsh-plugin-cost-ledger': '成本台账',
  'dsh-plugin-relay-quota': '中转额度',
  'dsh-plugin-spend-forecast': '花费预测',
  'dsh-plugin-price-aware': '价格感知',
  'dsh-plugin-token-telemetry': 'Token 遥测',
  'dsh-plugin-tool-trace': '工具追踪',
  'dsh-plugin-error-radar': '错误雷达',
  'dsh-plugin-cache-guard': '缓存护栏',
  'dsh-plugin-prompt-optimize': '提示词优化',
  'dsh-plugin-deep-scan': '深度扫描',
  'dsh-plugin-eco-scan': '生态扫描',
  'dsh-plugin-local-deep-search': '本地深搜',
  'dsh-plugin-task-forge': '任务工坊',
  'dsh-plugin-ide-hub': 'IDE 中枢',
  'dsh-plugin-family-cards': '家族卡片',
  'dsh-plugin-plugin-forge': '插件锻造',
};

const REQUIRES_BY_CATEGORY = {
  '会话与知识库': ['tools', 'sessionProjections'],
  '钱与用量': ['tools', 'systemPrompt', 'sessionProjections'],
  '工具与质量': ['tools', 'llmMiddleware'],
  '扫描与研究': ['tools'],
  '编排与界面': ['tools', 'systemPrompt'],
  '构建与开发工具': ['tools'],
};

function parseEntries(source, id) {
  const fromTicks = [...String(source ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  const unique = [...new Set(fromTicks.filter(Boolean))];
  return unique.length ? unique : [`/${id.replace(/^dsh-plugin-/, '')}`];
}

const plugins = catalog.plugins
  .filter((entry) => entry.listed !== false)
  .map((entry) => {
    const id = entry.repo;
    return {
      id,
      repo: `121212165/${id}`,
      npm: `@deepseek-ai/${id}`,
      name: NAMES[id] ?? id.replace(/^dsh-plugin-/, ''),
      oneLiner: entry.featuredBlurb ?? entry.blurb,
      category: entry.category,
      entries: parseEntries(entry.featuredEntries ?? entry.entries, id),
      requires: REQUIRES_BY_CATEGORY[entry.category] ?? ['tools'],
      dshRange: '>=0.1.2-rc.1 <0.2.0',
      license: 'MIT',
      author: '121212165',
      borrowedFrom: [],
      verifiedAt: catalog.fetchedAt ?? '2026-11-21',
    };
  });

const groups = [
  {
    id: 'starter-three',
    name: '开局三件套',
    oneLiner: '先看见钱，再看见所有 IDE，最后能跨窗口派活',
    members: ['dsh-plugin-quota', 'dsh-plugin-ide-hub', 'dsh-plugin-task-forge'],
    why: [
      'task-forge 直接读取 quota 发布的 summary.json 预算契约，派活前先卡预算',
      'ide-hub 的 /today 聚合 quota / cost-ledger / task-forge / tool-trace 四家事实，三件套装完即可看到统一视图',
    ],
    installOrder: '按 members 顺序：quota → ide-hub → task-forge',
    conflicts: [],
    verify: [
      'dump-config 含三个 id',
      '/qm 有输出；/ide-hub 能列出至少 1 个 IDE；/forge 只回显不落盘',
    ],
    curator: 'editor',
    updatedAt: '2026-11-21',
  },
  {
    id: 'archive-chain',
    name: '归档链',
    oneLiner: '一次 /archive 跑通导出 → 推送 → 检索',
    members: ['dsh-plugin-transcript', 'dsh-plugin-obsidian-push', 'dsh-plugin-transcript-search'],
    why: [
      'transcript 产出的 sessions/*.jsonl 是 obsidian-push 与 transcript-search 共同消费的契约文件',
      '/archive 串联三家：导出 JSONL → 推送到 Obsidian → 立即可被 transcript-search 检索',
    ],
    installOrder: '按 members 顺序：transcript → obsidian-push → transcript-search',
    conflicts: [],
    verify: [
      'dump-config 含三个 id',
      '/archive 产出一份 JSONL；/push 能在目标库看到对应笔记；/find 能搜回该会话',
    ],
    curator: 'editor',
    updatedAt: '2026-11-21',
  },
  {
    id: 'saving-combo',
    name: '省钱组合',
    oneLiner: '同读一份 per-call 成本台账，拦缓存、算预测、对账',
    members: ['dsh-plugin-cache-guard', 'dsh-plugin-spend-forecast', 'dsh-plugin-cost-ledger'],
    why: [
      '三家都读 cost-ledger 维护的 per-call token / 成本台账字段，口径一致不打架',
      'cache-guard 命中即省一次调用，spend-forecast 直接消费台账算燃烧率',
    ],
    installOrder: '按 members 顺序：cost-ledger 数据先立住，再装 cache-guard 与 spend-forecast',
    conflicts: [],
    verify: [
      'dump-config 含三个 id',
      '/health 显示缓存命中；/ledger 有本月汇总；/forecast 与台账口径一致',
    ],
    curator: 'editor',
    updatedAt: '2026-11-20',
  },
  {
    id: 'handoff-duo',
    name: '交接协作',
    oneLiner: '系统提示注入 + 跨窗口事实检索，换窗口不丢上下文',
    members: ['dsh-plugin-task-forge', 'dsh-plugin-pinboard', 'dsh-plugin-fact-vault'],
    why: [
      'task-forge 通过 systemPrompt.section 注入待编译任务，pinboard 用同一通道注入置顶事实',
      'fact-vault 从跨会话 JSONL 检索同一批字段，并通过出处字段找回来源',
    ],
    installOrder: '按 members 顺序：task-forge → pinboard → fact-vault',
    conflicts: [],
    verify: [
      'dump-config 含三个 id',
      '/pin 后新开会话系统提示含该条；/fact 能检索到带出处的同一事实',
    ],
    curator: 'editor',
    updatedAt: '2026-11-20',
  },
  {
    id: 'plugin-dev',
    name: '插件开发',
    oneLiner: 'forge 产物过 verify-plugin，cards 负责渲染交付',
    members: ['dsh-plugin-plugin-forge', 'dsh-plugin-prompt-optimize', 'dsh-plugin-family-cards'],
    why: [
      'plugin-forge 的 forgeFiles() 产物必须过 dsh-family-tools/tools/verify-plugin.mjs 的质量门',
      'prompt-optimize 改写 /market 入口提示词，family-cards 把结果渲染成家族统一卡片',
    ],
    installOrder: '按 members 顺序：plugin-forge → prompt-optimize → family-cards',
    conflicts: [],
    verify: [
      'dump-config 含三个 id',
      '/forge 产出插件骨架且过 verify-plugin；/cards 渲染出卡片',
    ],
    curator: 'editor',
    updatedAt: '2026-11-19',
  },
  {
    id: 'eco-radar',
    name: '生态雷达',
    oneLiner: '同一套 GitHub 搜索通道与止损规则，先扫后深挖',
    members: ['dsh-plugin-eco-scan', 'dsh-plugin-deep-scan'],
    why: [
      'eco-scan 与 deep-scan 共用 GitHub 搜索通道与搜索止损规则（超时/配额/去重）',
      'eco-scan 先出候选仓清单，deep-scan 按同一 repo id 做源码级复核',
    ],
    installOrder: '按 members 顺序：eco-scan → deep-scan',
    conflicts: [],
    verify: [
      'dump-config 含两个 id',
      '/eco-scan 产出候选清单；/deep-scan 对同一 repo id 给出结构清单',
    ],
    curator: 'editor',
    updatedAt: '2026-11-18',
  },
];

function writeJson(relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

for (const plugin of plugins) {
  writeJson(`data/plugins/${plugin.id}.json`, plugin);
}
for (const group of groups) {
  writeJson(`data/groups/${group.id}.json`, group);
}
writeJson('data/categories.json', catalog.categories);

console.log(`seeded ${plugins.length} plugins (from catalog.source.json), ${groups.length} groups, ${catalog.categories.length} categories`);
