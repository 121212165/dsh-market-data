# TASK F8 — 贡献分 & 防刷（可解释排名）

> 仓库：`dsh-market-data`（本仓库目前无远程，分支本地）  
> 分支：`task/f8-score`（worktree `wt-f8-score`）  
> 基线：`main @ 45153c1`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F8、§8 刷票风险  
> 依赖：**F1、F2、F3、F7 全部先合并**（分 = 收录 + 被组合 + 被融合 + 有效票）  
> 合并顺序：最后一步

## 目标
贡献分 = 收录 + 被组合 + 被融合 + 有效票；权重公开；榜单可解释，任一条目能看到自己的分从哪来。

## 交付物
- `scripts/score.mjs`（新）：四项加权、权重常量公开在 `schema/score.weights.json`
- `scripts/build-index.mjs`：把 `score` 与 `scoreBreakdown` 写入 `index.json`
- `site/index.html`：每条展示"分从哪来"明细（收录/组合/融合/有效票分项）
- `test/score.test.mjs`：刷票降权、权重变更可解释、条目明细完整三类
- 防刷：沿用 F2 的一人一票 + 账号龄门槛，重复票不计入"有效票"

## 验收证据（计划原文）
榜单可解释：任一条目能看到自己的分从哪来

## 实施建议
1. 权重文件必须是唯一真源，代码与页面都从它读，避免漂移。
2. `scoreBreakdown` 每项写来源 id（如哪个组收录、哪次融合），不能只给数字。
3. 本地无远程时复验生成物，报告注明"Actions 未实跑"。

## 边界
- 不改投稿表单（F1）、投票抓取（F2）、融合算法（F3）、死链判定（F7），只消费其输出

## 完成判定
`node --test` 全绿；任一条目有完整 `scoreBreakdown` 且页面可解释；提交信息 `feat(f8): explainable contribution score and anti-gaming weights`。
