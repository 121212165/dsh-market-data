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

本地等价复验（无 gh 身份/远程时）：

```bash
npm test                       # node --test，全绿
npm run verify:f1              # 四样本 + PR 正文契约 → f1-report.json
node scripts/submission.mjs check --issue test/fixtures/submissions/<样本>.md   # 退出码 0/1
```

诚实声明（沿用 M4 口径）：本地无 gh 身份/远程，**Actions 未实跑**；`verify-plugin` 在本地证据里
以注入的确定性输出复验 PR 正文包含关系，真实 Action 在 GitHub 上对投稿 repo 跑 vendored 工具。

## 投票快照（F2）

每个插件一条 Discussion（标题 `Vote: <plugin-id>`，正文带 `<!-- dsh-market-plugin-id: <plugin-id> -->` 稳定标记），只统计 👍 reaction：

```bash
# 真跑（需要 token；GraphQL 必须认证）
GITHUB_TOKEN=... node scripts/vote-snapshot.mjs --category "Plugin Votes"

# 无 token 的离线复验（fixture 不访问 GitHub API）
node scripts/vote-snapshot.mjs --fixture test/fixtures/votes/discussions.json
node scripts/build-index.mjs && node scripts/build-site.mjs
node --test test/vote-snapshot.test.mjs
```

规则：按 GitHub `databaseId`（缺则 login 小写）去重 → **一人一票**；账号龄 < 30 天（可用 `--min-account-age-days` 调整）不计；`createdAt` 缺失/非法失败关闭；非 👍 reaction 不计。产物 `data/votes.json` 同时提供每个插件的 `votes` 与 `generatedAt`，`build-index` 用它作为**唯一来源**写入 `index.json`（超 24h 页面自动标「快照」）。`npm run validate` 会校验 votes 契约、孤儿票与汇总一致性。

`.github/workflows/vote-snapshot.yml` 定时（6h）+ 手动抓取并提交刷新后的 `votes.json` / `index.json` / `snapshot.json` / `site/index.html`。插件侧 `/market vote` 与未登录 `gh auth login` 指引由插件仓独立提交补齐，不在本仓。
