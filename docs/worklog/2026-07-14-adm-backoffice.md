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

## 环节 2 · SRV-9 管理操作日志

- TDD：先写 4 用例（401 / 三类动作自动落日志含 detail / type 过滤+total / 失败登录不落）跑失败，再实现。
- 实现：SCHEMA 加 admin_ops+settings（settings 顺手建好给环节 3 用）；`logOp(action, detail)` 单行 helper；login/publish/rollback 三处埋点；`GET /api/admin/ops` 带过滤分页。
- 结果：37/37 绿（新增 4）。
- 决策：埋点只记成功路径（失败登录不记，避免日志被爆破噪音填满——本地项目，无告警需求）。
- 踩坑：无。耗时感受：小（一次过）。

## 环节 3 · 经济参数动态化（SRV-7 后台侧，服务 ADM-7）

- TDD：4 用例（401 / 默认值 / 改后签到实得新额+日志含前后值 / 五种非法值全 400 且不污染）。
- 实现：`getEconomy()` 读 settings 覆盖默认（缺 key/缺字段回退）；`canClaimRelief`/`playerState` 改签名传参；claim-daily/claim-relief/PUT 校验（正整数、冷却≤168h）。
- 结果：41/41 绿；旧 economy.test.ts 10 用例未破坏。
- 决策：**不把 PITY/INITIAL_BALANCE 纳入可调**——保底参数是数学模型一部分（动了会破坏 RTP 口径），初始余额影响统计口径，都留在代码常量；ADM-7 范围收敛为纯经济缓冲三参数。
- 踩坑：playerState 有 6 个调用点要跟着改签名，编译器兜底，无遗漏。

## 环节 4 · SRV-6a 玩家管理 API（服务 ADM-5）

- TDD：5 用例（401×5 端点 / 列表聚合列+query / credit 流水+日志+非法 400+404 / ban-spin-403-unban / reset 清态记差额）。
- 实现：列表 LEFT JOIN spins 聚合子查询；credit/reset 走 db.transaction（更新+流水+日志原子）；ban/unban 循环注册两端点。
- 结果：46/46 绿。
- 决策：ban/unban 无资金变动 → 只进 admin_ops 不进 transactions（对账不变量 1 不受影响）；reset 的流水 amount 记差额（可为负），保证不变量 1 仍成立。
- 踩坑：无。

## 环节 5 · SRV-6b 审计查询 + 回放校验（服务 ADM-4）

- TDD：4 用例（401 / 过滤分页+winX / minWinX / 回放 match=true + **json_set 篡改 totalWin 后 match=false** + 404）。
- 实现：列表条件拼接（playerId/from/to/minWinX），连锁数用 `json_array_length(result_json,'$.cascades')` 免解析大 JSON；详情端点用 engine `spin()` 重跑。
- 结果：50/50 绿。
- 决策（比计划更强）：计划原定"比对 totalWin/scatterCount 等四字段"的简化口径；读 spin.ts 后确认 free 局起始倍数就是 `cascades[0].chainMultiplier`（必为 ladder 值，`ladderRungOf` 可精确还原 rung），于是升级为**整个 SpinResult JSON.stringify 逐字节比对**。审计强度显著提高，零额外成本。
- 踩坑：测试文件手滑写了个畸形 import（`from 'vitest' extends never ? …`），一眼修掉。**复盘点：长 session 里连续产出文件时开头模板容易串行。**
