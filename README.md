# dsh-market-data

市集的数据仓（M0 前置）：一插件一文件、一组一文件，`data/index.json` 由 Actions/本地脚本生成。

```bash
npm run seed      # 首次生成 25 插件 / 6 组种子（已提交，正常无需重跑）
npm run check     # build-index + validate
```

校验门禁：重复 id / 死链 repo / 组成员不存在 / `why` 为空 / `verify` 为空 / 组内命令名冲突都会报红。
