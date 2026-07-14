# 实施日志 · 后台完善（thread-55）

> 目的：每个实施环节对应需求编号，记录过程与决策，供复盘优化实施流程。
> 计划：`docs/superpowers/plans/2026-07-14-adm-backoffice.md`。分支 `worktree-adm-backoffice`（worktree 隔离，基于 main d9d952b）。

## 环节 0 · 准备（无需求编号）

- 勘察：admin 仅登录+日聚合表；SRV-4/ADM-2a-2c 已由前序波次完成；主 checkout 有其他线程 WIP → 起 worktree 隔离。
- 需求梳理：ADM-2~5 细化为 12 条 + SRV-9，入池提交 `df56227`。
- 基线：engine 29 + server 33 测试全绿后才开工。
- 决策：服务端 TDD（vitest + app.inject）；admin 侧无测试基建，验收走 tsc + Playwright 截图（与 repo 现状一致，测试基建留给 INF-2）。

## 环节 1 · 契约先行（对应 ADM-3~8 / SRV-5/6/9 的接口面）

- CT-2 v0.2：stats 拆三端点（rows/summary/distributions）、玩家管理五端点、审计两端点（详情加 `replayCheck`）、经济参数 GET/PUT、操作日志 GET；补 PlayerAdminRow/SpinRow/EconomyParams/AdminOpRow 四个类型。
- CT-3 v0.2：加 `admin_ops`（只增不改）与 `settings`（KV，value 一律 JSON）两表。
- 决策记录：
  - **资金与管理动作分账**：transactions 只管钱，管理动作（含 ban/unban 这类无资金动作）一律进 admin_ops——避免流水表被非资金记录污染对账不变量。
  - **回放校验放服务端**：admin 不引 engine，防止"前端一套判定逻辑"违反唯一真相源纪律。
  - **经济参数用 settings KV** 而非专表：目前仅一组参数，YAGNI。
- 踩坑：CT-3 在前序（已被上下文压缩的）会话片段里已改好，差点重复编辑——Edit 的 file-modified 保护挡住了。**复盘点：上下文压缩后恢复实施前，应先 `git diff` 看工作区实际状态再动手。**
