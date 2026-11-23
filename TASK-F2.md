# TASK F2 — 投票（Discussion reaction → index）

> 仓库：`dsh-market-data`（本仓库目前无远程，分支本地）  
> 分支：`task/f2-vote`（worktree `wt-f2-vote`）  
> 基线：`main @ 45153c1`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F2、§5.2 写路径  
> 依赖：无（可与 F1、F5 同时开跑）  
> 合并顺序：F2 → F7 → F8；与 F1 同批合并

## 目标
每个插件条目一条 Discussion，reaction 快照进入 `index.json`；一人一票 + 账号龄门槛；未登录只读票数。

## 交付物
- `.github/workflows/vote-snapshot.yml`：定时/手动抓取条目 Discussion 的 👍 reaction，按"一人一票 + 账号龄门槛"过滤，产出 `data/votes.json`
- `scripts/vote-snapshot.mjs`：GraphQL 抓取 + 去重 + 账号龄过滤，带 `--dry-run` 与 fixture 模式
- `scripts/build-index.mjs`：把 `votes.json` 汇总进 `index.json`（票数与 `generatedAt` 同源）
- `test/`：重复投票只计 1、未达账号龄不计、快照与 Discussion 数一致三类测试
- 插件侧 `/market vote` 命令与"未登录给 `gh auth login` 指引"属跨仓后续项，本分支只做数据侧；合并时用单独小提交补到插件仓（不要塞进 F3/F4/F5/F6）

## 验收证据（计划原文）
- 同一账号重复投票只计 1
- 未登录看不到可投按钮且给出登录指引（插件侧后续项）
- 榜单页票数与 Discussion 一致

## 实施建议
1. 复用 `index.json` 的 `generatedAt` 机制，超 24h 页面标"快照"（§5.1）。
2. Discussion 标题/正文用稳定 id 关联插件 id，避免名称变更断链。
3. 本地无 token 时用 fixture 复验，报告中注明"GitHub API 未实跑"。

## 边界
- 不改投稿表单（F1）
- 不改贡献分计算（F8 会消费本分支票数）

## 完成判定
三类测试全绿；`index.json` 票数与 fixture Discussion 一致；提交信息 `feat(f2): discussion vote snapshot into index`。
