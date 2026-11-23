# TASK F1 — 投稿（Issue Form → 校验 → 自动 PR）

> 仓库：`dsh-market-data`（本仓库目前无远程，分支本地）  
> 分支：`task/f1-submission`（worktree `wt-f1-submission`）  
> 基线：`main @ 45153c1`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F1、§5.2 写路径  
> 依赖：无（可与 F2、F5 同时开跑）  
> 合并顺序：F1 → F7 → F8；与 F2 同批合并

## 目标
作者通过 GitHub Issue Form 投稿插件；必填 `repo` / `license` / 借鉴来源表；Action 先跑 `verify-plugin`，通过后自动开 PR 到数据仓。

## 交付物
- `.github/ISSUE_TEMPLATE/plugin-submission.yml`：三个必填字段 + 格式校验提示
- `.github/workflows/submission.yml`：解析 issue → `scripts/validate`/`check-pr` 校验 → 跑插件仓 vendored `verify-plugin` → `peter-evans/create-pull-request` 类动作开 PR（PR 正文带校验结果）
- 校验复用现有 `scripts/check-pr.mjs` / `scripts/validate.mjs`，不重新造规则
- `test/` 或 `scripts/test-*.mjs`：缺 license、缺借鉴来源、重复 id 三类坏样本 + 一条合格样本

## 验收证据（计划原文）
- 缺 `license` 的投稿被拒
- 合格投稿 10 分钟内生成带校验结果的 PR

## 实施建议
1. 先看 `scripts/catalog.source.json` 的字段结构与 `check-pr.mjs` 的错误码。
2. 投稿先落成 `catalog.source.json` 的草稿条目，再走 PR；不要直接写 `data/index.json`（那是 Actions 生成物）。
3. 本地无 gh 身份/远程时，用 `node scripts/check-pr.mjs <fixture>` + 手工模拟 PR 正文复验，并在报告中如实标注"Actions 未实跑"（沿用 M4 诚实声明口径）。

## 边界
- 不改 `data/index.json` 生成逻辑（F2 会碰，避免冲突）
- 不做投票、融合、贡献分

## 完成判定
`npm test`（或 `node --test`）全绿；坏样本全部报红、合格样本全绿；PR 正文含 verify-plugin 输出；提交信息 `feat(f1): submission issue form and PR gate`。
