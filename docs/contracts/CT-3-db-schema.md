# CT-3 · 数据库 Schema（SQLite，v0.1 草案）

> 所有者：`apps/server`（admin/web 一律经 API，不直连库）。
> 变更记录：2026-07-14 v0.1 初稿。
> 金额整数（文）。时间统一 UTC ISO-8601 文本。迁移用编号 SQL 文件（`migrations/0001_init.sql`…）。

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 玩家（游客账号；将来注册升级复用本表加列）
CREATE TABLE players (
  id                      INTEGER PRIMARY KEY,
  token                   TEXT NOT NULL UNIQUE,        -- 游客 Bearer token（随机 128bit hex）
  balance                 INTEGER NOT NULL DEFAULT 10000,  -- 初始 10,000 文
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  -- 免费旋转 / 保底 状态（服务端权威）
  free_spins_remaining    INTEGER NOT NULL DEFAULT 0,
  free_spin_bet           INTEGER NOT NULL DEFAULT 0,  -- 触发时锁定的注
  accumulated_multiplier  REAL    NOT NULL DEFAULT 0,
  dice_progress           INTEGER NOT NULL DEFAULT 0,  -- 0–99
  last_daily_claim_at     TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at            TEXT
);

-- 游戏配置（版本化；engine 的 GameConfig 原样存 JSON）
CREATE TABLE game_configs (
  version        INTEGER PRIMARY KEY,                  -- 自增语义：max+1，由 server 分配
  label          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  config_json    TEXT NOT NULL,
  estimated_rtp  REAL,                                 -- 最近一次 simulate 结果
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at   TEXT
);
-- 不变量：status='published' 的行至多一条（server 在发布事务里保证）

-- Spin 全量审计（回放 = seed + config_version 重跑 engine，须与 result_json 一致）
CREATE TABLE spins (
  id              INTEGER PRIMARY KEY,
  player_id       INTEGER NOT NULL REFERENCES players(id),
  config_version  INTEGER NOT NULL REFERENCES game_configs(version),
  seed            TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('base','free')),
  bet             INTEGER NOT NULL,
  total_cost      INTEGER NOT NULL,                    -- 实际扣款（ante 含加成；free=0）
  ante_enabled    INTEGER NOT NULL DEFAULT 0,
  total_win       INTEGER NOT NULL,
  win_tier        TEXT CHECK (win_tier IN ('peng','gang','hu','zimo','tianhu')),
  scatter_count   INTEGER NOT NULL DEFAULT 0,
  free_spins_awarded INTEGER NOT NULL DEFAULT 0,
  result_json     TEXT NOT NULL,                       -- 完整 SpinResult
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_spins_player_time ON spins(player_id, created_at);
CREATE INDEX idx_spins_time        ON spins(created_at);
CREATE INDEX idx_spins_config      ON spins(config_version, created_at);

-- 余额流水（所有改余额的路径都必须落一条）
CREATE TABLE transactions (
  id             INTEGER PRIMARY KEY,
  player_id      INTEGER NOT NULL REFERENCES players(id),
  type           TEXT NOT NULL CHECK (type IN (
                   'bet','win','daily_bonus','bankrupt_relief','loss_rebate',
                   'admin_credit','admin_reset')),
  amount         INTEGER NOT NULL,                     -- 有符号：bet 为负，win/发币为正
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  ref_spin_id    INTEGER REFERENCES spins(id),
  note           TEXT,                                 -- 管理操作备注
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tx_player_time ON transactions(player_id, created_at);
CREATE INDEX idx_tx_type_time   ON transactions(type, created_at);
```

## 对账不变量（看板与审计的根基）

1. 任意玩家：`players.balance == 初始额 + SUM(transactions.amount)`。
2. 实测 RTP（任意区间/版本）：`SUM(spins.total_win) / SUM(spins.total_cost)`（free spin 的 total_cost=0、赢奖计入分子——免费旋转的价值天然归入触发它的付费 spin 群体）。
3. 一次 `POST /api/spin` = 事务内原子完成：spins 1 行 + transactions ≤2 行（bet、win>0 时）+ players 状态更新。
