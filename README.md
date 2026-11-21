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
