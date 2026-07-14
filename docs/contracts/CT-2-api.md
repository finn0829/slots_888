# CT-2 · HTTP API 契约（v0.1 草案）

> 生产者：`apps/server`（Fastify）。消费者：`apps/web`、`apps/admin`。
> 变更记录：2026-07-14 v0.1 初稿。

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

**`POST /api/spin` 服务端语义**（web 不实现任何判定）：
1. `freeSpinsRemaining > 0` ⇒ 本次为 free spin：忽略请求的 bet/ante，用 `freeSpinBet`，不扣款，次数 −1。
2. 否则校验 bet ∈ betLevels、余额 ≥ totalCost，扣款。
3. 生成 seed（CSPRNG）→ 调 engine `spin()` → 事务内：记 spins、记 transactions（bet + win 两条）、更新 PlayerState（免费次数 += freeSpinsAwarded、diceProgress += scatterCount，**满 100 归零并 +10 次免费旋转**、accumulatedMultiplier 持久化）。
4. 返回 `SpinResult + PlayerState`。余额在任何路径下不得为负。

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
| `GET /api/admin/stats` | 聚合统计 | `?from&to&groupBy=day\|configVersion` → `{ rows: StatRow[] }` |
| `GET /api/admin/players` | 玩家列表/搜索 | `?query&page` → `{ players, total }` |
| `POST /api/admin/players/:id/credit` | 补发虚拟币 | `{ amount, note }` → `{ state }` |
| `POST /api/admin/players/:id/reset` | 重置为初始状态 | → `{ state }` |
| `POST /api/admin/players/:id/ban` / `unban` | 封禁/解封 | → `{ state }` |
| `GET /api/admin/spins` | 审计查询 | `?playerId&from&to&minWinX&page` → `{ spins: SpinRow[], total }` |
| `GET /api/admin/spins/:id` | 单局完整数据（含 result_json，admin 逐步回放） | → `{ spin: SpinRow, result: SpinResult }` |

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
```

## 关键不变量

- **理论 vs 实测闭环**：`StatRow.rtp` 必须可由 spins 表逐条对账复算。
- 每条 spin 记录关联 `config_version` + `seed`，管理端回放 = 用同 seed/config 重跑 engine，结果必须与落库 result_json 一致。
- 所有改余额的路径（spin/签到/管理操作）都必须写 transactions 流水。
