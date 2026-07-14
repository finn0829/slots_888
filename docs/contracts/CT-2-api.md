# CT-2 · HTTP API 契约（v0.2）

> 生产者：`apps/server`（Fastify）。消费者：`apps/web`、`apps/admin`。
> 变更记录：2026-07-14 v0.1 初稿；2026-07-14 v0.2 后台完善——统计 summary/分布、经济参数、操作日志端点，审计回放加 replayCheck。

## 通用约定

- 所有请求/响应 `application/json`；金额一律整数（文）。
- 玩家侧鉴权：`Authorization: Bearer <playerToken>`。管理侧：`Authorization: Bearer <adminToken>`。
- 错误统一格式 + HTTP 状态码：

```ts
interface ApiError { error: { code: string; message: string } }
// 400 BAD_REQUEST · 401 UNAUTHORIZED · 403 BANNED · 402 INSUFFICIENT_BALANCE
// 404 NOT_FOUND · 409 CONFLICT（如对非 draft 配置发布）· 429 RATE_LIMITED
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
| `GET /api/config` | 当前生效配置的**公开部分** | — | `{ version: number, betLevels: number[], paytable: …, anteRule: { costMultiplier: 1.25 }, maxWinX: 5000 }` |
| `POST /api/spin` | 旋转（唯一改变余额的玩家操作） | `{ bet: number, anteEnabled: boolean }` | `{ spin: SpinResult, state: PlayerState }` |
| `POST /api/claim-daily` | 每日签到补币（**1,000 文**/日，UTC 日界） | — | `{ amount: number, state: PlayerState }`；已领过 → 409 |
| `POST /api/claim-relief` | 破产补币：余额 < 最低注(10) 时可领 **2,000 文**，冷却 **4 小时** | — | `{ amount: number, state: PlayerState }`；不满足 → 409 |
| `GET /api/last-spin` | 该玩家最后一局的完整 SpinResult（断线重连用） | — | `{ spin: SpinResult \| null }`；从未转过 → `{ spin: null }` |

**`POST /api/spin` 服务端语义**（web 不实现任何判定）：
1. `freeSpinsRemaining > 0` ⇒ 本次为 free spin：忽略请求的 bet/ante，用 `freeSpinBet`，不扣款，次数 −1。
2. 否则校验 bet ∈ betLevels、余额 ≥ totalCost，扣款。
3. 生成 seed（CSPRNG）→ 调 engine `spin()` → 事务内：记 spins、记 transactions（bet + win 两条）、更新 PlayerState（免费次数 += freeSpinsAwarded、diceProgress += scatterCount，**满 100 归零并 +10 次免费旋转**、accumulatedMultiplier 持久化）。
4. 返回 `SpinResult + PlayerState`。余额在任何路径下不得为负。

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
