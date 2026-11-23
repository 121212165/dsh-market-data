# TASK F7 — 数据治理（每日快照 / 死链降权 / 陈旧标记）

> 仓库：`dsh-market-data`（本仓库目前无远程，分支本地）  
> 分支：`task/f7-governance`（worktree `wt-f7-governance`）  
> 基线：`main @ 45153c1`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F7、§8 GitHub 数据滞后风险  
> 依赖：**F1、F2 先合并**（需要投稿/投票数据进入 index）  
> 合并顺序：F1/F2 → F7 → F8

## 目标
每日抓 stars / npm 周下载快照；404 死链降权；N 天无更新标记；首页不展示失效条目。

## 交付物
- `.github/workflows/daily-snapshot.yml`：定时抓 stars/npm，写入 `data/snapshots/`
- `scripts/snapshot.mjs`：带失败降级与 fixture 模式；404 记录 `deadSince`
- `scripts/build-index.mjs`：按 `deadSince` 超过 7 天自动降级并写 `demotionReason`，页面标注原因
- `site/index.html`：陈旧/降级徽标（复用 §5.1 超 24h 标"快照"的口径）
- `test/`：404 → 7 天降级用例、快照缺失不崩用例

## 验收证据（计划原文）
一个 404 仓 7 天内自动从首页降级并标注原因

## 实施建议
1. 死链判定要可回放：fixture 里给 `deadSince`，不要真等 7 天。
2. 降级只影响首页排序/展示，不删除条目，保留恢复路径。
3. 本地无远程时用等价命令复验，报告注明"定时任务未实跑"。

## 边界
- 不改投稿（F1）、投票抓取（F2）逻辑，只消费其输出
- 不做贡献分（F8）

## 完成判定
`node --test` 全绿；404 fixture 在第 7 天降级且页面有原因标注；提交信息 `feat(f7): daily snapshot dead-link demotion and stale badges`。
