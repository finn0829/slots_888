# ENG-8 / SRV-11 / WEB-15 · Bonus Buy（2026-07-15）

分支 `eng-8-bonus-buy`（基于 origin/main = 2929ce0）。数学报告见 `docs/reports/eng8-bonus-buy-rtp.md`。

## 做了什么

花钱直接买 10 次免费旋转（= 保底段）。引擎数学**零改动**：买入是纯服务端状态操作（扣钱 + 置 freeSpinsRemaining=10 + Ante 关），免费旋转本身走现有 spin 逻辑，之后玩家点「继续」复用 WEB-18 流程打完。

- **引擎**：`GameConfig` 加 `bonusBuy: {enabled, costMultiplier}`；`analyze.ts` 导出 `featureSegmentValueX`（直接模拟 N 次段价值，供定价/守卫）并把 `pityValueX` 补进 `AnalyzeResult`；标定脚本 `bonusbuy-calibrate.ts`；红线单测 `bonusbuy-rtp.test.ts`。
- **服务端**：`POST /api/bonus-buy`（权威扣款/校验，`bonus_buy` 流水）；`/api/config` 下发 `bonusBuy`；`/api/stats` 把买入花费计入 totalBet + 新增 `bonusBuySpent`；admin `today` 汇总 RTP 也把买入花费算进分母；db 的 transactions CHECK 加 `bonus_buy` + 老库整表重建迁移。
- **前端**：盘面加「买免费旋转」按钮（成本用服务端下发值，二次确认，复用 fs 横幅）；规则页加 Bonus Buy 章节公示买入价与"买入档 RTP ≈ 全局 RTP"。
- **后台**：配置编辑加 Bonus Buy enabled 开关（costMultiplier 只读透传），随发布生效。

## 定价（四档，500k 段标定）

买入价 = E[10 次段价值×注] / nominalRtp，约 **44× 注**（bet=100 → 4,430 文）。四档 buyMult：rtp92 44.21 / rtp945 44.86 / rtp965 44.30 / rtp975 44.51。独立 seed 复测买入档 RTP 与公示 RTP 偏差 ≤0.66pp（噪声 ±0.5pp），落在验收误差内。E[段价值] ≈ 42×，与 ENG-10 的 v10=42.6× 交叉一致。

## 遇到的坑 / 决策

1. **买入价 ~44× 不是 ~100×**。业界常说 bonus buy ~100×，是因为那类游戏一段 feature 值 ~100× 注；本游戏一段 10 次只值 ~42×，按同一 RTP 定价自然 ~44×。价格跟 E[段价值] 走不跟直觉走——照 ENG-10 铁律用分析器实测。
2. **对账不变量差点被悄悄打破**。玩家 `totalBet` 来自 `spins.total_cost`，买来的免费旋转赢奖进 `spins.total_win` 却没有对应付费 spin —— 若只记 transaction 不补进分母，个人/看板 RTP 会被抬虚（正是"审计曲线会暴露"的问题）。已在 `/api/stats`（个人）和 admin `today` 汇总把 `−SUM(bonus_buy)` 补进分母。
3. **CHECK 约束不能 ALTER**。加 `bonus_buy` 交易类型要么删库重建，要么整表重建。写了 db.ts 迁移：检测 transactions 表 sql 不含 `bonus_buy` 就 rename→建新表→copy→drop→重建索引（FK 期间关）。fresh 库走新 SCHEMA，老库走迁移。
4. **不重新引入线性折算**（ENG-10 血泪）。定价的 `featureSegmentValueX` 固定 award=10 直接模拟整段，不按次数外推。

## 我替用户默认了、需要确认的

- **"该档基础 RTP" 取该档公示 RTP（nominalRtp，整体返奖率）**，不是 base-game-only RTP。理由：买入应和"正常玩这一档"一样公道；若对 base-game RTP 定价会离谱地贵。
- **admin 按日/按版本聚合、玩家列表 totalBet 仍只读 spins.total_cost**，未把 bonus_buy 归因进去（bonus_buy 无 config_version，无法按版本归因）。只修了最显眼的个人 RTP 与 admin `today` 汇总。demo 下不阻断，已在 CT-3 不变量注记。如需按版本精确归因，得给 bonus_buy 交易加 config_version 列（未做）。
- **buyMult 存进 preset 表、随 payoutScale 每档单独标**（像 nominalRtp）。后台改权重会让它失效，UI 已提示"改权重后须重标"，但未做自动重标——与现有 nominalRtp 的陈旧问题同源同处理。
- 买入 award 固定 = pity.award（10）。若以后想让买入次数可选（如买 15 次），要重新标定且改前端。

## 验证

- 引擎单测 **65 全绿**（新增 `bonusbuy-rtp` 7 项：默认档一致性、四档默认开、四档买入档 RTP≈公示且不显著低于（红线）、买入价随档位）。`npx vitest run --pool=forks --root packages/engine`（末尾 `Timeout calling onTaskUpdate` 是本机 threads 池环境噪声，10 文件全 passed）。
- 服务端单测 **80 全绿**（新增 `bonus-buy` 10 项：config 下发、扣款/落库、余额不足 402、封禁 403、关闭 403、非法注 400、已有免费旋转 409、Ante 强制关、个人对账、余额守恒）。`npx vitest run --pool=forks --root apps/server`。
- 标定实测：见报告表格，四档复测偏差 ≤0.66pp。
- `npm run typecheck -ws` 四个工作区全过。
- **浏览器 e2e 写好但未运行**（端口被并行任务占用，主 agent 串行跑）：`scripts/e2e-bonusbuy.mjs` + `npm run e2e:bonusbuy`。覆盖：按钮显真实价、二次确认买入、扣款、进 10 次免费旋转、横幅、免费旋转期按钮隐藏、个人统计对账、规则页公示、打完后按钮复现。
