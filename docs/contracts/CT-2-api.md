# CT-2 · HTTP API 契约（v0.4）

> 生产者：`apps/server`（Fastify）。消费者：`apps/web`、`apps/admin`。
> 变更记录：2026-07-14 v0.1 初稿；2026-07-14 v0.2 后台完善——统计 summary/分布、经济参数、操作日志端点，审计回放加 replayCheck。
> 2026-07-15 v0.3 玩家侧新增 `GET /api/history`（WEB-14 赢奖历史，游标分页 + 终盘盘面）。
> 2026-07-15 v0.4（ENG-8 Bonus Buy）：新增 `POST /api/bonus-buy`；`/api/config` 增下发 `bonusBuy`；`/api/stats` 增 `bonusBuySpent`（买入花费计入总投入）。

## 通用约定

- 所有请求/响应 `application/json`；金额一律整数（文）。
- 玩家侧鉴权：`Authorization: Bearer <playerToken>`。管理侧：`Authorization: Bearer <adminToken>`。
- 错误统一格式 + HTTP 状态码：

```ts
interface ApiError { error: { code: string; message: string } }
// 400 BAD_REQUEST · 401 UNAUTHORIZED · 403 BANNED / BONUS_BUY_DISABLED · 402 INSUFFICIENT_BALANCE
// 404 NOT_FOUND · 409 CONFLICT（如对非 draft 配置发布 / 已有免费旋转时买入）· 429 RATE_LIMITED
```

- 玩家公共状态对象（多个接口返回）：

```ts
interface PlayerState {
  playerId: number;
  balance: number;
  freeSpinsRemaining: number;
  freeSpinBet: number;              // 触发免费旋转时锁定的注
  accumulatedMultiplier: number;    // 免费局累加倍数
  diceProgress: number;             // 保底进度 0–99（满 100 即触发并归零）
  status: 'active' | 'banned';
}
```

## 玩家侧

| 方法/路径 | 说明 | 请求 | 响应 |
|---|---|---|---|
| `POST /api/session` | 创建游客账号（幂等：带旧 token 则返回原账号） | `{ token?: string }` | `{ token: string, state: PlayerState }` |
| `GET /api/me` | 查询状态 | — | `{ state: PlayerState }` |
| `GET /api/config` | 当前生效配置的**公开部分** | — | `{ version, betLevels, paytable, rtp, anteRule: {...}, bonusBuy: { enabled, costMultiplier }, maxWinX, pity, freeSpins }` |
| `POST /api/spin` | 旋转（唯一改变余额的玩家操作） | `{ bet: number, anteEnabled: boolean }` | `{ spin: SpinResult, state: PlayerState }` |
| `POST /api/bonus-buy` | 买入免费旋转（ENG-8） | `{ bet: number }` | `{ cost: number, freeSpinsAwarded: number, state: PlayerState }` |
| `POST /api/claim-daily` | 每日签到补币（**1,000 文**/日，UTC 日界） | — | `{ amount: number, state: PlayerState }`；已领过 → 409 |
| `POST /api/claim-relief` | 破产补币：余额 < 最低注(10) 时可领 **2,000 文**，冷却 **4 小时** | — | `{ amount: number, state: PlayerState }`；不满足 → 409 |
| `GET /api/last-spin` | 该玩家最后一局的完整 SpinResult（断线重连用） | — | `{ spin: SpinResult \| null }`；从未转过 → `{ spin: null }` |
| `GET /api/history` | 该玩家最近若干局（游标分页，可展开看终盘盘面，WEB-14） | `?before=<spinId>&limit=20` | `{ history: HistoryRow[], nextCursor: number \| null }` |

**`GET /api/history` 语义（WEB-14）**：需玩家鉴权（未登录 401）。按 `spins.id` 降序返回该玩家自己的最近记录（**不串号**）。

- `limit`：默认 **20**，上限 **50**（超出即截断为 50；非法值回退默认）。
- `before`：游标 = 上一页最后一条的 `spinId`，返回 `id < before` 的更早记录；缺省则从最新开始。
- `nextCursor`：本页最后一条的 `spinId`；当本页返回数 **< limit**（无更早记录）时为 `null`。前端据此决定是否显示「加载更多」。
- **免费局口径**（与个人统计 `/api/stats` 一致）：`isFree = (mode === 'free')`，其 `totalCost = 0`（**不计入投入**）；`bet` 为触发时锁定的注，`winX = totalWin / bet` 仍有意义。
- `finalGrid`：该局落库 `result_json` **最后一个 cascade 的 `gridAfter`**（6×5 终盘），供前端直接 `board.setGrid` 渲染，无需再拉完整 SpinResult。engine 是唯一真相源，前端只渲染不重算。

```ts
interface HistoryRow {
  spinId: number;
  createdAt: string;                 // UTC ISO-8601
  mode: 'base' | 'free';
  isFree: boolean;                   // mode === 'free'
  bet: number;                       // 该局的注（免费局为锁定注）
  totalCost: number;                 // 实际投入（免费局 = 0，不计入投入）
  totalWin: number;                  // 文，已含所有倍数
  winX: number;                      // totalWin / bet（该局赢奖倍数）
  winTier: WinTier | null;
  finalGrid: Grid;                   // 终盘（result_json 末个 cascade 的 gridAfter）
}
```

**公示 RTP（`rtp` 字段，ENG-10）**：`estimated_rtp ?? nominalRtp`——管理员改过权重并跑过模拟器的版本以估算值为准（此时预设的标定值已失效），否则用配置自带的标定值。**前端不得写死这个数**：后台改一次权重，写死的数字就成了对玩家的谎言（概率诚实原则红线）。同理 `anteRule` 的触发率也是按当前配置解析计算的。

**`POST /api/spin` 服务端语义**（web 不实现任何判定）：
1. `freeSpinsRemaining > 0` ⇒ 本次为 free spin：忽略请求的 bet/ante，用 `freeSpinBet`，不扣款，次数 −1。
2. 否则校验 bet ∈ betLevels、余额 ≥ totalCost，扣款。
3. 生成 seed（CSPRNG）→ 调 engine `spin()` → 事务内：记 spins、记 transactions（bet + win 两条）、更新 PlayerState（免费次数 += freeSpinsAwarded、diceProgress += scatterCount，**满 100 归零并 +10 次免费旋转**、accumulatedMultiplier 持久化）。
4. 返回 `SpinResult + PlayerState`。余额在任何路径下不得为负。

**`POST /api/bonus-buy` 服务端语义**（ENG-8，web 不实现任何判定）：
1. 校验：未登录 → 401；封禁 → 403 BANNED；已有免费旋转未打完 → 409 CONFLICT（不许叠买）。
2. 取生效配置；`bonusBuy.enabled === false` → **403 `BONUS_BUY_DISABLED`**。
3. 校验 `bet ∈ betLevels`（否则 400）；`cost = round(bet × bonusBuy.costMultiplier)`（整数文）；余额 < cost → **402 INSUFFICIENT_BALANCE**。
4. 事务内：扣款（记一条 `transactions` type=`bonus_buy`，amount=−cost，**计入玩家总投入**，不写 spins）、置 `freeSpinsRemaining = pity.award(=10)`、`freeSpinBet = bet`、`accumulatedMultiplier = 1`。**Ante 与买入无关**（免费旋转本就忽略 ante）。
5. 返回 `{ cost, freeSpinsAwarded, state }`。之后玩家用 `POST /api/spin` 把免费旋转打完（复用 WEB-18「继续」流程）。
- **买入价定价（概率诚实红线）**：`costMultiplier` 按「买入档 RTP ≈ 该档公示 RTP」标定（买入价 = E[10 次段价值×注] / nominalRtp），花钱买回来的期望返奖率与正常玩这一档一致。前端展示「花 N× 买入（= X 文）」**全用下发的 costMultiplier**，绝不写死。
- **个人统计对账**：买来的免费旋转赢奖进 `spins.total_win`（→ `/api/stats` 的 totalWin/分子），买入价进 `bonusBuySpent` 且加入 `totalBet`（分母），个人实测 RTP 仍自洽。

**断线重连（WEB-18）**：免费旋转状态（剩余次数、累计倍数、freeSpinBet、保底进度）本就在服务端持久化，刷新页面不丢局。但前端需要恢复**演出上下文**——否则玩家看到的是随机 demo 盘面配着"免费旋转还剩 7 次"，无从判断上一局发生了什么。
`GET /api/last-spin` 返回最后一局的 SpinResult，web 取其最后一次 cascade 的 `gridAfter` 作为开局盘面（即上一局的真实终盘）。这只是**展示恢复**，不产生任何判定；免费旋转要继续，仍须玩家点「开局」再发一次 `POST /api/spin`。

## 管理侧（全部需管理员鉴权，未登录一律 401）

| 方法/路径 | 说明 | 请求 → 响应 |
|---|---|---|
| `POST /api/admin/login` | 密码登录（密码来自 env） | `{ password }` → `{ adminToken }` |
| `GET /api/admin/configs` | 配置版本列表 | → `{ configs: ConfigMeta[] }` |
| `GET /api/admin/configs/:version` | 单版本完整配置 | → `{ config: GameConfig, meta: ConfigMeta }` |
| `POST /api/admin/configs` | 新建草稿（从某版本复制或从预设档位） | `{ baseVersion?: number, preset?: 'rtp92'\|'rtp945'\|'rtp965'\|'rtp975', label: string, config?: GameConfig }` → `{ meta: ConfigMeta }` |
| `PUT /api/admin/configs/:version` | 修改草稿（仅 draft 可改） | `{ config, label? }` → `{ meta }` |
| `POST /api/admin/configs/:version/publish` | 发布（原 published 版本自动 retired） | → `{ meta }` |
| `POST /api/admin/configs/:version/rollback` | 回滚到某历史版本（复制为新版本并发布） | → `{ meta }` |
| `POST /api/admin/simulate` | 蒙特卡洛估算（调 engine.simulate） | `{ config: GameConfig, spins?: number /*默认 200_000*/ }` → `{ rtp, hitRate, fsTriggerRate, avgWinX, maxWinX, stdevX, elapsedMs }` |
| `GET /api/admin/stats` | 聚合统计 | `?groupBy=day\|configVersion`（默认 day）→ `{ rows: StatRow[] }`；groupBy=configVersion 时 key=`v{version}` |
| `GET /api/admin/stats/summary` | 看板汇总卡 | → `{ today: { spins, totalBet, totalWin, rtp, uniquePlayers, bigWins }, publishedVersion, theoreticalRtp, totalPlayers }`；bigWins = 赢奖 ≥50× 注的 spin 数（BIG_WIN_X=50） |
| `GET /api/admin/stats/distributions` | 看板分布 | → `{ winTiers: {tier,count,totalWin}[], betLevels: {bet,count}[], cascadeDepth: {depth,count}[], fsTriggerRate }`；各分布 count 加总可与总 spin 数对账 |
| `GET /api/admin/players` | 玩家列表/搜索 | `?query&page` → `{ players: PlayerAdminRow[], total }`；query 匹配 id 精确或 token 前缀；每页 20，last_seen_at 倒序 |
| `POST /api/admin/players/:id/credit` | 补发虚拟币 | `{ amount, note? }` → `{ state }`；amount 须为正整数；流水 type=`admin_credit` |
| `POST /api/admin/players/:id/reset` | 重置为初始状态（余额 10000、清免费旋转/保底） | → `{ state }`；流水 type=`admin_reset`（amount=差额） |
| `POST /api/admin/players/:id/ban` / `unban` | 封禁/解封（无流水，进操作日志） | → `{ state }` |
| `GET /api/admin/spins` | 审计查询 | `?playerId&from&to&minWinX&page` → `{ spins: SpinRow[], total }`；每页 20，id 倒序 |
| `GET /api/admin/spins/:id` | 单局完整数据 + 回放校验 | → `{ spin: SpinRow, result: SpinResult, replayCheck: { match: boolean } }`；服务端用 engine 以 seed+config_version 重跑，比对 totalWin/scatterCount/freeSpinsAwarded/cascades 数 |
| `GET /api/admin/economy` | 经济参数 | → `{ params: EconomyParams }` |
| `PUT /api/admin/economy` | 修改经济参数（进操作日志，含前后值） | `{ params: EconomyParams }` → `{ params }`；非法值（非正整数、cooldown>168）→ 400 |
| `GET /api/admin/ops` | 管理操作日志（只读） | `?type&page` → `{ ops: AdminOpRow[], total }`；每页 50，倒序 |

```ts
interface ConfigMeta {
  version: number; label: string;
  status: 'draft' | 'published' | 'retired';
  estimatedRtp: number | null;      // 最近一次 simulate 结果
  createdAt: string; publishedAt: string | null;
}
interface StatRow {
  key: string;                       // 日期或版本号
  spins: number; totalBet: number; totalWin: number;
  rtp: number; hitRate: number; fsTriggerRate: number;
  uniquePlayers: number;
}
interface PlayerAdminRow {
  id: number; balance: number; status: 'active' | 'banned';
  createdAt: string; lastSeenAt: string | null;
  spins: number; totalBet: number; totalWin: number;   // 聚合自 spins 表
}
interface SpinRow {
  id: number; playerId: number; configVersion: number;
  mode: 'base' | 'free'; bet: number; totalCost: number;
  totalWin: number; winX: number;                      // totalWin / bet
  winTier: string | null; cascades: number;            // 连锁步数
  createdAt: string;
}
interface EconomyParams {
  dailyBonus: number;            // 默认 1000
  reliefAmount: number;          // 默认 2000
  reliefCooldownHours: number;   // 默认 4，上限 168
}
interface AdminOpRow {
  id: number;
  action: 'login' | 'config_publish' | 'config_rollback' | 'player_credit'
        | 'player_reset' | 'player_ban' | 'player_unban' | 'economy_update';
  detail: string;                // JSON：动作参数与前后值
  createdAt: string;
}
```

## 关键不变量

- **理论 vs 实测闭环**：`StatRow.rtp` 必须可由 spins 表逐条对账复算。
- 每条 spin 记录关联 `config_version` + `seed`，管理端回放 = 用同 seed/config 重跑 engine，结果必须与落库 result_json 一致。
- 所有改余额的路径（spin/签到/管理操作）都必须写 transactions 流水。
