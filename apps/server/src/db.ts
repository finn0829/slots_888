import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultPreset } from '@slots/engine';

// CT-3 Schema（docs/contracts/CT-3-db-schema.md）
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id                      INTEGER PRIMARY KEY,
  token                   TEXT NOT NULL UNIQUE,
  balance                 INTEGER NOT NULL DEFAULT 10000,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  free_spins_remaining    INTEGER NOT NULL DEFAULT 0,
  free_spin_bet           INTEGER NOT NULL DEFAULT 0,
  accumulated_multiplier  REAL    NOT NULL DEFAULT 0,
  dice_progress           INTEGER NOT NULL DEFAULT 0,
  last_daily_claim_at     TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at            TEXT
);

CREATE TABLE IF NOT EXISTS game_configs (
  version        INTEGER PRIMARY KEY,
  label          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  config_json    TEXT NOT NULL,
  estimated_rtp  REAL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at   TEXT
);

CREATE TABLE IF NOT EXISTS spins (
  id              INTEGER PRIMARY KEY,
  player_id       INTEGER NOT NULL REFERENCES players(id),
  config_version  INTEGER NOT NULL REFERENCES game_configs(version),
  seed            TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('base','free')),
  bet             INTEGER NOT NULL,
  total_cost      INTEGER NOT NULL,
  ante_enabled    INTEGER NOT NULL DEFAULT 0,
  total_win       INTEGER NOT NULL,
  win_tier        TEXT CHECK (win_tier IN ('peng','gang','hu','zimo','tianhu')),
  scatter_count   INTEGER NOT NULL DEFAULT 0,
  free_spins_awarded INTEGER NOT NULL DEFAULT 0,
  result_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_spins_player_time ON spins(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_spins_time        ON spins(created_at);
CREATE INDEX IF NOT EXISTS idx_spins_config      ON spins(config_version, created_at);

CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY,
  player_id      INTEGER NOT NULL REFERENCES players(id),
  type           TEXT NOT NULL CHECK (type IN (
                   'bet','win','daily_bonus','bankrupt_relief','loss_rebate',
                   'admin_credit','admin_reset')),
  amount         INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  ref_spin_id    INTEGER REFERENCES spins(id),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_player_time ON transactions(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type_time   ON transactions(type, created_at);
`;

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // 首次启动：把默认预设发布为 version 1
  const hasPublished = db.prepare("SELECT 1 FROM game_configs WHERE status = 'published'").get();
  if (!hasPublished) {
    db.prepare(
      "INSERT INTO game_configs (version, label, status, config_json, estimated_rtp, published_at) VALUES (1, ?, 'published', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run('默认档 RTP 96.5（ENG-1 实测 95.6±0.9）', JSON.stringify(defaultPreset()), 0.9558);
  }
  return db;
}
