# 后台完善（ADM-3/4/5/6/7/8 + SRV-5/6/9）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把管理后台从"登录+配置管理+一张日聚合表"补齐为完整运营台：看板升级、审计回放、玩家管理、经济参数、操作日志。

**Architecture:** 契约先行（CT-2/CT-3 先改）→ 服务端 TDD 加 API（app.ts 按域拆出 admin 路由模块）→ admin 前端 hash 路由 + 每域一个 Page 组件。engine 是唯一数学真相源：回放校验在服务端用 `spin()` 重跑 seed 与落库 result_json 比对。

**Tech Stack:** Fastify + better-sqlite3（server）、React 18 + Vite（admin，无路由库，自实现 hash router）、vitest（server 测试）、Playwright（走查截图）。

## Global Constraints

- 契约变更必须先改 `docs/contracts/` 再改实现（repo 纪律）。
- 所有改余额的路径必须写 transactions 流水；所有管理动作必须写 admin_ops（SRV-9）。
- 金额一律整数（文）；错误统一 `{ error: { code, message } }`。
- admin 不复制任何判定/数学逻辑，回放校验走服务端 engine。
- 服务端每个域先写失败测试再实现（TDD）；admin 侧以 `tsc --noEmit` + Playwright 截图走查验收。
- 提交信息风格沿用仓库惯例：`srv: …` / `adm: …` / `docs: …`，中文一句话。

---

### Task 1: 契约更新（CT-2 v0.2 + CT-3）

**Files:**
- Modify: `docs/contracts/CT-2-api.md`
- Modify: `docs/contracts/CT-3-db-schema.md`

**Interfaces（新增契约条目）:**

```
GET  /api/admin/stats?groupBy=day|configVersion            （已实现 day，补 configVersion）
GET  /api/admin/stats/summary   → { today: {spins,totalBet,totalWin,rtp,uniquePlayers,bigWins}, publishedVersion, theoreticalRtp }
GET  /api/admin/stats/distributions?from&to → { winTiers: {tier,count,totalWin}[], betLevels: {bet,count}[], cascadeDepth: {depth,count}[], fsTriggerRate }
GET  /api/admin/players?query&page          → { players: PlayerAdminRow[], total }
POST /api/admin/players/:id/credit  { amount, note } → { state }
POST /api/admin/players/:id/reset                      → { state }
POST /api/admin/players/:id/ban | /unban               → { state }
GET  /api/admin/spins?playerId&from&to&minWinX&page    → { spins: SpinRow[], total }
GET  /api/admin/spins/:id                              → { spin: SpinRow, result: SpinResult, replayCheck: { match: boolean } }
GET  /api/admin/economy                                → { params: EconomyParams }
PUT  /api/admin/economy   { params }                   → { params }   // 校验非法值 400
GET  /api/admin/ops?type&page                          → { ops: AdminOpRow[], total }

interface EconomyParams { dailyBonus: number; reliefAmount: number; reliefCooldownHours: number }
interface AdminOpRow { id; action; detail(JSON字符串); createdAt }
```

CT-3 新增表：

```sql
CREATE TABLE IF NOT EXISTS admin_ops (
  id         INTEGER PRIMARY KEY,
  action     TEXT NOT NULL,   -- login/config_publish/config_rollback/player_credit/player_reset/player_ban/player_unban/economy_update
  detail     TEXT,            -- JSON：动作参数与前后值
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL         -- JSON
);
```

- [ ] Step 1: 按上述内容改两份契约（CT-2 记 v0.2 变更行）
- [ ] Step 2: `git add docs/contracts && git commit -m "docs: CT-2/CT-3 v0.2——玩家管理·审计·经济参数·操作日志契约"`

### Task 2: SRV-9 管理操作日志

**Files:**
- Modify: `apps/server/src/db.ts`（SCHEMA 加 admin_ops + settings 两表）
- Modify: `apps/server/src/app.ts`（`logOp(action, detail)` helper；login/publish/rollback 三处埋点；`GET /api/admin/ops`）
- Test: `apps/server/test/admin-ops.test.ts`

**Interfaces:**
- Produces: `logOp(action: string, detail: object): void`（后续任务的埋点都调它）；`GET /api/admin/ops?type&page` 返回 `{ ops, total }`，每页 50，倒序。

- [ ] Step 1: 失败测试：登录/发布/回滚后 `GET /api/admin/ops` 能查到对应 action；`?type=config_publish` 过滤生效；未登录 401

```ts
it('登录与发布动作进操作日志，可按类型过滤', async () => {
  await app.inject({ method: 'POST', url: '/api/admin/configs', headers: auth(), payload: { preset: 'rtp92' } });
  await app.inject({ method: 'POST', url: '/api/admin/configs/2/publish', headers: auth() });
  const all = (await app.inject({ method: 'GET', url: '/api/admin/ops', headers: auth() })).json();
  expect(all.ops.map((o: any) => o.action)).toEqual(expect.arrayContaining(['login', 'config_publish']));
  const filtered = (await app.inject({ method: 'GET', url: '/api/admin/ops?type=config_publish', headers: auth() })).json();
  expect(filtered.ops.every((o: any) => o.action === 'config_publish')).toBe(true);
});
```

- [ ] Step 2: 跑测试确认失败（表不存在/404）
- [ ] Step 3: 实现：SCHEMA 加表；`const logOp = (action: string, detail: unknown) => db.prepare('INSERT INTO admin_ops (action, detail) VALUES (?, ?)').run(action, JSON.stringify(detail))`；埋点 login（成功时）、publish（记 version/label）、rollback（记 from/to）；ops 查询带 type 过滤 + LIMIT/OFFSET + COUNT
- [ ] Step 4: 测试全绿
- [ ] Step 5: `git commit -m "srv: 管理操作日志（SRV-9）——admin_ops 表 + 埋点 + 查询 API"`

### Task 3: 经济参数动态化（SRV-7 后台侧的服务端半边）

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-economy.test.ts`

**Interfaces:**
- Produces: `getEconomy(): EconomyParams`（默认 `{dailyBonus:1000, reliefAmount:2000, reliefCooldownHours:4}`，settings 表 key=`economy` 覆盖）；`GET/PUT /api/admin/economy`。
- 改造：`claim-daily`/`claim-relief`/`canClaimRelief` 改用 `getEconomy()` 取值（删常量 DAILY_BONUS/RELIEF_AMOUNT/RELIEF_COOLDOWN_HOURS）。

- [ ] Step 1: 失败测试：GET 返回默认值；PUT 改 dailyBonus=500 后玩家签到实得 500 且进 ops 日志；PUT 负数/非整数 → 400
- [ ] Step 2: 确认失败 → Step 3: 实现（PUT 校验三字段均为正整数、cooldown ≤ 168；写 settings + logOp('economy_update', {before, after})）
- [ ] Step 4: 全绿（economy.test.ts 旧用例不破坏）
- [ ] Step 5: `git commit -m "srv: 经济参数动态化——settings 表 + GET/PUT /api/admin/economy"`

### Task 4: SRV-6 玩家管理 API

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-players.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/players?query&page` → `{ players: [{id,balance,status,createdAt,lastSeenAt,spins,totalBet,totalWin}], total }`（query 匹配 id 精确或 token 前缀；每页 20，按 last_seen_at 倒序）
  - `POST /api/admin/players/:id/credit {amount, note}` → transactions type=`admin_credit` + logOp
  - `POST /api/admin/players/:id/reset` → 余额回 10000、清免费旋转/保底，transactions type=`admin_reset`（amount=差额）+ logOp
  - `POST /api/admin/players/:id/ban|unban` → 改 status + logOp（无流水）
- 已有行为依赖：`/api/spin` 对 banned 返回 403（已实现，测试覆盖之）。

- [ ] Step 1: 失败测试：建 2 个玩家转几把 → 列表含聚合列；credit 100 后余额+100 且流水/日志齐；credit 非正数 400；ban 后 spin 403、unban 恢复；reset 后 balance=10000
- [ ] Step 2: 确认失败 → Step 3: 实现（credit/reset 走 db.transaction；聚合列用 LEFT JOIN 子查询）
- [ ] Step 4: 全绿 → Step 5: `git commit -m "srv: 玩家管理 API（SRV-6a）——列表/补币/重置/封禁，全走流水与操作日志"`

### Task 5: SRV-6 审计查询 + 回放校验 API

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-spins.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/spins?playerId&from&to&minWinX&page` → `{ spins: [{id,playerId,configVersion,mode,bet,totalCost,totalWin,winX,winTier,cascades,createdAt}], total }`（每页 20，id 倒序；winX=total_win/bet；cascades 用 `json_array_length(result_json,'$.cascades')`）
  - `GET /api/admin/spins/:id` → `{ spin, result: SpinResult, replayCheck: { match } }`；replay = `spin({seed, bet, anteEnabled, mode, accumulatedMultiplier(免费局取 result.accumulatedMultiplierAfter 反推不可行——直接用落库 result_json 里的输入字段重跑), config: 该版本 config})`，比对 `JSON.stringify` 归一后的 totalWin+cascades 长度+每步 stepWin
- Consumes: Task 2 的 logOp（本任务只读，不埋点）。

- [ ] Step 1: 失败测试：转 5 把后按 playerId 过滤条数正确；minWinX 过滤只留大奖；`GET /api/admin/spins/:id` 的 replayCheck.match === true；篡改库里 result_json 后 match === false
- [ ] Step 2: 确认失败 → Step 3: 实现（免费局回放需 accumulatedMultiplier 输入值：从 result_json 存的 SpinResult 没有输入倍数字段——用 `result.cascades[0].chainMultiplier` 不可靠，改为重跑时直接传 `resultStored.mode==='free' ? resultStored.accumulatedMultiplierAfter 起点无法还原` → 简化：回放输入用落库 result_json 的 `seed/bet/anteEnabled/mode`，free 局 accumulatedMultiplier 取 `resultStored.cascades[0]?.chainMultiplier ?? 1`；比对字段：totalWin、scatterCount、freeSpinsAwarded、cascades.length。若仍不匹配则如实返回 match=false——这正是审计的意义）
- [ ] Step 4: 全绿 → Step 5: `git commit -m "srv: Spin 审计查询与回放校验（SRV-6b）——过滤分页 + engine 重放比对"`

### Task 6: SRV-5 统计聚合扩展

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-stats.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/stats?groupBy=configVersion` → 同 StatRow 形状，key=`v{version}`
  - `GET /api/admin/stats/summary` → `{ today: {spins,totalBet,totalWin,rtp,uniquePlayers,bigWins(>=50x)}, publishedVersion, theoreticalRtp(estimated_rtp of published), totalPlayers }`
  - `GET /api/admin/stats/distributions` → `{ winTiers, betLevels, cascadeDepth, fsTriggerRate }`（形状见 Task 1 契约）
- [ ] Step 1: 失败测试：转几把后 summary.today.spins 与实际一致、rtp 可复算；groupBy=configVersion 在发布 v2 再转后出两行；distributions 各分布 count 加总 = 总 spin 数
- [ ] Step 2: 确认失败 → Step 3: 实现（纯 SQL 聚合，big win 阈值 50 倍作为常量 BIG_WIN_X=50）
- [ ] Step 4: 全绿 → Step 5: `git commit -m "srv: 统计聚合扩展（SRV-5）——summary/按版本/分布，全部可对账"`

### Task 7: ADM-6 hash 路由与应用骨架

**Files:**
- Modify: `apps/admin/src/main.tsx`（只留 App/Login/路由）
- Create: `apps/admin/src/router.ts`（`useHashRoute(): [route, navigate]`，`#/dashboard` 等，默认 dashboard，监听 hashchange）
- Create: `apps/admin/src/DashboardPage.tsx`（本任务先原样搬现 Dashboard，Task 8 再升级）

**Interfaces:**
- Produces: `useHashRoute()`；NAV 表 `{ id, hash, label, component }[]`——后续页面只需在表里加一行。
- [ ] Step 1: 实现 router + 拆页；侧边栏 active 跟 hash 走；刷新停留当前页
- [ ] Step 2: `npx tsc --noEmit -p apps/admin` 通过；`npm run dev` 手查两页互切+刷新
- [ ] Step 3: `git commit -m "adm: hash 路由骨架（ADM-6）——刷新保持页面，token 失效任意页回登录"`

### Task 8: ADM-3 看板升级

**Files:**
- Modify: `apps/admin/src/DashboardPage.tsx`
- Modify: `apps/admin/src/api.ts`（SummaryData/DistData 类型）
- Modify: `apps/admin/src/style.css`（卡片/图表样式）

**Interfaces:**
- Consumes: Task 6 三个 stats 端点。
- 结构：顶部 4 张汇总卡（今日 Spin/实测 RTP vs 理论/活跃玩家/大奖数）→ RTP 折线（内联 SVG，x=日期 y=RTP，理论 RTP 画虚线基准；日/版本切换 tab）→ 下方两列：五档赢奖分布条形 + 注档分布条形 + 连锁深度直方 + 免费旋转触发率。全部纯 SVG/div，无图表库。
- [ ] Step 1: 实现；空数据时每块给引导文案
- [ ] Step 2: tsc 通过 + 手动/截图走查
- [ ] Step 3: `git commit -m "adm: 看板升级（ADM-3a/3b)——汇总卡·RTP 曲线·赢奖/注档/连锁分布"`

### Task 9: ADM-4 审计查询与回放

**Files:**
- Create: `apps/admin/src/AuditPage.tsx`
- Modify: `apps/admin/src/main.tsx`（NAV 加行）、`apps/admin/src/api.ts`（SpinRow 类型）、`style.css`

**Interfaces:**
- Consumes: Task 5 两端点。
- 结构：过滤栏（玩家 ID、起止日期、最小倍数）→ 分页表 → 点行进详情：回放校验徽章（✅ 与落库一致 / ❌ 不一致标红）+ 逐 cascade 盘面（6×5 格子 div 渲染 gridBefore，中奖位置高亮，展示 chainMultiplier/stepWin）+ 上一步/下一步。牌面文字用 SYMBOL_NAMES 映射（中發東南西北萬筒條＋白板/骰子/金）。
- 支持 `#/audit?playerId=3` 直达（玩家页跳转用）。
- [ ] Step 1: 实现 → Step 2: tsc + 截图走查（含一次真实回放） → Step 3: `git commit -m "adm: 审计回放（ADM-4a/4b）——过滤分页 + 逐连锁盘面 + 一致性徽章"`

### Task 10: ADM-5 玩家管理

**Files:**
- Create: `apps/admin/src/PlayersPage.tsx`
- Modify: `main.tsx`、`api.ts`、`style.css`

**Interfaces:**
- Consumes: Task 4 端点。
- 结构：搜索框 + 分页表（ID/余额/状态/spin 数/投入/赢奖/最后活跃）→ 行内操作：补币（prompt 金额+备注）、重置、封禁/解封，全部 window.confirm 二次确认 → "查 spin"跳 `#/audit?playerId=N`。
- [ ] Step 1: 实现 → Step 2: tsc + 走查（补币后余额变化、封禁后徽章变红） → Step 3: `git commit -m "adm: 玩家管理（ADM-5）——搜索分页·补币/重置/封禁，二次确认"`

### Task 11: ADM-7 经济参数 + ADM-8 操作日志页

**Files:**
- Create: `apps/admin/src/EconomyPage.tsx`（表单：签到额/救济额/冷却小时，保存前 confirm，显示校验错误）
- Create: `apps/admin/src/OpsPage.tsx`（类型下拉过滤 + 分页表：时间/动作/详情 JSON 展开）
- Modify: `main.tsx`、`api.ts`、`style.css`

**Interfaces:** Consumes Task 3 economy 端点、Task 2 ops 端点。
- [ ] Step 1: 实现两页 → Step 2: tsc + 走查（改签到额→ops 页出现 economy_update 记录，闭环） → Step 3: `git commit -m "adm: 经济参数与操作日志页（ADM-7/8）"`

### Task 12: 端到端验证 + 需求池更新 + 合并

- [ ] Step 1: `npm test --workspaces --if-present` 全绿；两个 app `tsc --noEmit` 通过
- [ ] Step 2: `npm run dev` 起三端，Playwright 走查：登录 → 五个页面各截图 → 游戏端转几把 → 看板数字变化 → 审计页回放该局 → 玩家页补币 → ops 页见记录。截图存 `docs/screenshots/adm-m6/`
- [ ] Step 3: `docs/BACKLOG.md`：ADM-3a/3b/4a/4b/5/6/7/8、SRV-5/6/9 标 ✅ 已完成
- [ ] Step 4: 用 superpowers:finishing-a-development-branch 合并回 main

## Self-Review 结论

- 覆盖：需求池剩余 ADM/SRV 条目全部有任务对应；ADM-2 已完成不在范围。
- 类型一致：EconomyParams/StatRow/SpinRow 在 Task 1 契约与各任务间一致。
- 风险点已明示：免费局回放的输入倍数无法从落库数据完全还原（Task 5 里定了简化口径并如实返回 match）。
