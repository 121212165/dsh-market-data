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

`.github/workflows/vote-snapshot.yml` 定时（6h）+ 手动抓取并提交刷新后的 `votes.json` / `index.json` / `snapshot.json` / `site/index.html`。插件侧 `/market vote` 与未登录 `gh auth login` 指引是跨仓后续项，不在本仓。
