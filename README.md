# dsh-market-data

市集的数据仓（M0 前置）：一插件一文件、一组一文件，`data/index.json` 由 Actions/本地脚本生成。

```bash
npm run seed      # 首次生成 25 插件 / 6 组种子（已提交，正常无需重跑）
npm run check     # build-index + validate
```

校验门禁：重复 id / 死链 repo / 组成员不存在 / `why` 为空 / `verify` 为空 / 组内命令名冲突都会报红。

## 投稿流程

1. **只改 `data/`**：新插件加 `data/plugins/dsh-plugin-<id>.json`，新组合加 `data/groups/<id>.json`。
2. **不要改 `scripts/catalog.source.json`**：它是 `seed.mjs` 的种子输入，CI 不跑 seed。改它不会同步到已生成的 `data/`，也不会进 index。
3. PR 会自动跑 `scripts/check-pr.mjs`：占位字段、group 缺 `why`、含糊 `verify`、未知成员（`UNKNOWN_MEMBER`）、重复 id（`DUPLICATE_ID`）、组内重复成员（`DUPLICATE_MEMBER`）都会报红，每条错误带 `entryPath` 指向具体文件。
4. 本地预检：`node scripts/check-pr.mjs data/plugins/<你的文件>.json`，再跑 `npm run check`。

### F1 投稿：Issue Form → 校验 → 自动 PR

作者也可以走 Issue 表单：打开 `.github/ISSUE_TEMPLATE/plugin-submission.yml`（标签 `submission`），
填完三个必填字段 `repo`（`owner/name`）、`license`（MIT / Apache-2.0 / BSD-3-Clause / ISC）、
**借鉴来源表**（至少一行真实来源）。编辑该 Issue 会重新触发 Action。

`.github/workflows/submission.yml` 的流程：

1. `scripts/submission.mjs prepare` 解析表单 → 生成 `data/plugins/dsh-plugin-<id>.json` 草稿
   （字段映射参考 `scripts/catalog.source.json`；**不改**该种子文件，也**不直接写** `data/index.json`，
   它由合并后的 build 流程生成）。选填字段留空时用具体默认值，不写占位词。
2. 复用现有规则校验：`scripts/validate.mjs` 的 `validateDataset` + `scripts/check-pr.mjs` 的
   `checkEntry` / `checkCrossEntry`；缺 license（缺 repo / 缺借鉴来源同理）、重复 id 一律报红，
   失败时把错误码回帖到 Issue，不开 PR。
3. 对 `repo` 指向的插件仓跑 vendored 家族门禁
   `scripts/vendor/verify-plugin.mjs`（经 `scripts/verify-plugin-gate.mjs` 包装，输出可机读）。
4. `peter-evans/create-pull-request` 开 PR，PR 正文含校验结果表格和 **verify-plugin 原始输出**。

本地等价复验（本机 `gh auth status --hostname github.com` 已认证；但当前目标仓 `121212165/dsh-market-data` 返回 HTTP 404，且此工作区没有 Git remote）：

```bash
npm test                       # node --test，全绿
npm run verify:f1              # 四样本 + PR 正文契约 → f1-report.json
node scripts/submission.mjs check --issue test/fixtures/submissions/<样本>.md   # 退出码 0/1
```

诚实声明（沿用 M4 口径）：本机 GitHub 身份已认证，但目标数据仓不存在/不可访问（HTTP 404）且本地无 remote，**Actions 未实跑**；`verify-plugin` 在本地证据里
以注入的确定性输出复验 PR 正文包含关系，真实 Action 在 GitHub 上对投稿 repo 跑 vendored 工具。认证成功不代表目标仓可访问。

## 投票快照（F2）

每个插件一条 Discussion（标题 `Vote: <plugin-id>`，正文带 `<!-- dsh-market-plugin-id: <plugin-id> -->` 稳定标记），只统计 👍 reaction：

```bash
# 真跑（需要 token；GraphQL 必须认证）。脚本先分页读取 discussionCategories，按名称取 category id；
# 再读取受支持的 repository.discussions connection 并按 category.id 本地筛选。
GITHUB_TOKEN=... node scripts/vote-snapshot.mjs --category "Plugin Votes"

# 无 token 的离线复验（fixture 不访问 GitHub API）
node scripts/vote-snapshot.mjs --fixture test/fixtures/votes/discussions.json
node scripts/build-index.mjs && node scripts/build-site.mjs
node --test test/vote-snapshot.test.mjs
```

规则：按 GitHub `databaseId`（缺则 login 小写）去重 → **一人一票**；账号龄 < 30 天（可用 `--min-account-age-days` 调整）不计；`createdAt` 缺失/非法失败关闭；非 👍 reaction 不计。产物 `data/votes.json` 同时提供每个插件的 `votes` 与 `generatedAt`，`build-index` 用它作为**唯一来源**写入 `index.json`（超 24h 页面自动标「快照」）。`npm run validate` 会校验 votes 契约、孤儿票与汇总一致性。

`.github/workflows/vote-snapshot.yml` 定时（6h）+ 手动抓取并提交刷新后的 `votes.json` / `index.json` / `snapshot.json` / `site/index.html`。插件侧 `/market vote` 与未登录 `gh auth login` 指引由插件仓独立提交补齐，不在本仓。

诚实声明：GraphQL query/variables 与分页由 mock/fixture 合约测试覆盖；当前目标仓 API 返回 404，因此本轮生产 query 的 GitHub live 验证为 **unverified**，不得把 fixture 票数描述为真实 Discussion 或 Actions 结果。API 错误、仓库/category 缺失及任何分页不完整都会中止，保留原 `votes.json`。

## 数据治理（F7）

```bash
node scripts/snapshot.mjs                                              # eco-scan 指标优先 + GitHub 404 状态检查；缺字段再查 npm
node scripts/snapshot.mjs --fixture test/fixtures/snapshots/metrics.json --out data/snapshots
node scripts/build-index.mjs && node scripts/build-site.mjs            # 死链降级 / 陈旧标记写进 index 与页面
node --test                                                            # 当前 55 项全绿（含 eco-scan 映射与 404 → 7 天降级用例）
```

- **生态指标源已接入**：运行 `snapshot.mjs` 时先只读抓取 [`121212165/dsh-plugin-eco-scan`](https://github.com/121212165/dsh-plugin-eco-scan) 的 `data/eco-data.json`，按 `meta.columns` 中的 `id` / `stars` / `weekly` 列映射到本市集 `data/plugins/*.json` 的 `repo`。读取顺序为 GitHub raw（12 秒超时）→ jsDelivr 镜像；两者失败才完全回退到 GitHub/npm 实时指标。eco-scan 是指标源，不替代本仓的插件目录、组、投票或 `data/index.json`。可以通过 `ECO_SCAN_URL` 或 `--eco-scan-url` 覆盖 raw JSON 地址。
- **来源与失败策略**：eco-scan 指标优先；对本地目录中没有匹配记录或字段为 null 的条目，再用 GitHub/npm API 补齐。GitHub API 仍是仓库 404 的权威判定，eco-scan 的旧指标不会把 404 伪装成仓库存活。eco-scan 不可用或结构不兼容时降级到原 GitHub/npm 采集流程；生成快照的 `source` 记录 eco-scan 日期或降级来源。没有任何一层提供的指标都保持 `null`，不伪造为 0。
- 每天写 `data/snapshots/<YYYY-MM-DD>.json` + `latest.json`。只有 HTTP **404** 记为 `deadSince`（保留首次发现日，仓库恢复自动清除）；超时 / 403 / 429 视为失败降级，沿用上次好值，不误判死链。
- `build-index` 在 `now - deadSince >= 7` 天时写 `demotionReason`，把条目排到首页末尾；`build-site` 把它移出主列表并放进「已降级的失效条目」区块，页面显示降级原因徽标。**不删条目、保留恢复路径**；`N` 天（默认 30，可用 `staleDays` 调整）无更新写 `staleReason` 并显示陈旧徽标。
- 快照缺失 / 损坏不崩，也不触发降级（fail-safe）；「超 24h 标快照」的页首口径沿用 §5.1。
- `.github/workflows/daily-snapshot.yml` 每天 02:23 UTC 定时抓取并回写快照 / index / 页面。
- 诚实声明：本市集目录仓 `dsh-market-data` 仍无 remote，目标地址返回 404，**本仓定时任务未实跑**。`dsh-plugin-eco-scan` 是独立公开指标源，不是本仓 Git remote。当前 `data/snapshots/` 基线仍为 fixture（见 `source`）；live eco-scan 输入只用于后续运行快照脚本，fixture 不代表 live workflow。

## 贡献分（F8）

```bash
npm run check        # build-index + build-site + validate，生成带 score/scoreBreakdown 的 index 与页面
node --test          # score.test.mjs 等，当前 55 项全绿
node scripts/verify-m4.mjs   # index ↔ site 字节一致 + 内嵌 sha 校验
npm run verify:f8    # 重生成 F8 静态/fixture 证据；不会把 fixture 票数标成 live
```

- 公式 `score = Σ(分项数量 × 公开权重)`，权重唯一真源是 `schema/score.weights.json`（收录 5 / 被组合 3 / 被融合 4 / 有效票 1）；`scripts/score.mjs` 与 `scripts/build-site.mjs` 都从该文件读取，页面每条都可展开「分从哪来」并显示来源 id。
- **「被融合」分项已接 F3 真实事件**：`data/fusions.json` 源自 `task/f3-fuse@f34cdac` 的 `f3-fuse-evidence.md`（`dsh-plugin-quota` + `dsh-plugin-cost-ledger`，MIT 白名单，官方门禁 0 FAIL/0 WARN），`status: f3-real`，唯一事件 `fuse-quota-cost-ledger`；不再是 fixture 占位。
- 投票分项沿用 F2 的一人一票 + 账号龄 30 天门槛；重复票 / 未成年票 / 原始 reaction 数不计入。
- 诚实声明：本机 gh 已认证，但数据仓无 remote 且 GitHub API 返回 404；Actions 未实跑。票数与 Discussion 的一致性只在 fixture 上验证，真实 GitHub 数据及 Pages 部署均为 unverified / 发布阻塞。
