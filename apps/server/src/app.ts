import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { spin, type GameConfig, type SpinResult } from '@slots/engine';
import { openDb, type Db } from './db';

declare module 'fastify' {
  interface FastifyInstance {
    slotsDb: Db;
  }
}

export interface AppOptions {
  dbPath?: string;
  adminPassword?: string;
  logger?: boolean;
}

const BET_LEVELS = [10, 20, 50, 100, 200, 500];
const INITIAL_BALANCE = 10000;
const PITY_TARGET = 100;
const PITY_AWARD = 10;

interface PlayerRow {
  id: number;
  token: string;
  balance: number;
  status: 'active' | 'banned';
  free_spins_remaining: number;
  free_spin_bet: number;
  accumulated_multiplier: number;
  dice_progress: number;
}

function playerState(p: PlayerRow) {
  return {
    playerId: p.id,
    balance: p.balance,
    freeSpinsRemaining: p.free_spins_remaining,
    freeSpinBet: p.free_spin_bet,
    accumulatedMultiplier: p.accumulated_multiplier,
    diceProgress: p.dice_progress,
    status: p.status,
  };
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const db = openDb(opts.dbPath ?? process.env.SLOTS_DB ?? 'data/slots.db');
  app.decorate('slotsDb', db);
  const adminPassword = opts.adminPassword ?? process.env.SLOTS_ADMIN_PASSWORD ?? 'admin888';
  const adminTokens = new Set<string>();

  const getPlayerByToken = db.prepare('SELECT * FROM players WHERE token = ?');
  const getPublished = db.prepare("SELECT version, config_json FROM game_configs WHERE status = 'published' ORDER BY version DESC LIMIT 1");

  function bearer(req: FastifyRequest): string | null {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : null;
  }

  function requirePlayer(req: FastifyRequest): PlayerRow | null {
    const token = bearer(req);
    if (!token) return null;
    return (getPlayerByToken.get(token) as PlayerRow | undefined) ?? null;
  }

  app.get('/healthz', async () => ({ ok: true }));

  // ── 玩家侧 ──

  app.post('/api/session', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string };
    if (body.token) {
      const existing = getPlayerByToken.get(body.token) as PlayerRow | undefined;
      if (existing) return { token: existing.token, state: playerState(existing) };
    }
    const token = randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO players (token, balance) VALUES (?, ?)').run(token, INITIAL_BALANCE);
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid) as PlayerRow;
    return { token, state: playerState(p) };
  });

  app.get('/api/me', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    return { state: playerState(p) };
  });

  app.get('/api/config', async () => {
    const row = getPublished.get() as { version: number; config_json: string };
    const cfg = JSON.parse(row.config_json) as GameConfig;
    return {
      version: row.version,
      betLevels: BET_LEVELS,
      paytable: Object.fromEntries(
        Object.entries(cfg.symbols).map(([s, v]) => [s, v.pay.map((x) => x * cfg.payoutScale)]),
      ),
      anteRule: { costMultiplier: cfg.anteCostMultiplier },
      freeSpins: cfg.freeSpins,
      maxWinX: cfg.maxWinX,
      pity: { target: PITY_TARGET, award: PITY_AWARD },
    };
  });

  app.post('/api/spin', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    if (p.status === 'banned') return reply.code(403).send(apiError('BANNED', '账号已被封禁'));

    const body = (req.body ?? {}) as { bet?: number; anteEnabled?: boolean };
    const cfgRow = getPublished.get() as { version: number; config_json: string };
    const config = JSON.parse(cfgRow.config_json) as GameConfig;

    const isFree = p.free_spins_remaining > 0;
    const bet = isFree ? p.free_spin_bet : Number(body.bet);
    const anteEnabled = isFree ? false : Boolean(body.anteEnabled);

    if (!isFree && !BET_LEVELS.includes(bet)) {
      return reply.code(400).send(apiError('BAD_REQUEST', `非法注档: ${body.bet}，可用 ${BET_LEVELS.join('/')}`));
    }
    const totalCost = isFree ? 0 : Math.round(bet * (anteEnabled ? config.anteCostMultiplier : 1));
    if (p.balance < totalCost) {
      return reply.code(402).send(apiError('INSUFFICIENT_BALANCE', '余额不足'));
    }

    const seed = randomBytes(16).toString('hex');
    const result: SpinResult = spin({
      seed, bet, anteEnabled,
      mode: isFree ? 'free' : 'base',
      accumulatedMultiplier: isFree ? (p.accumulated_multiplier || 1) : undefined,
      config,
    });

    const run = db.transaction(() => {
      let balance = p.balance - result.totalCost + result.totalWin;
      let freeRemaining = p.free_spins_remaining;
      let freeBet = p.free_spin_bet;
      let acc = p.accumulated_multiplier;
      let dice = p.dice_progress;

      if (isFree) {
        freeRemaining = freeRemaining - 1 + result.freeSpinsAwarded;
        acc = result.accumulatedMultiplierAfter;
        if (freeRemaining <= 0) { freeRemaining = 0; freeBet = 0; acc = 0; }
      } else {
        if (result.freeSpinsAwarded > 0) {
          freeRemaining += result.freeSpinsAwarded;
          freeBet = bet;
          acc = 1;
        }
        // 保底只在基础局累计（与模拟器口径一致）
        dice += result.scatterCount;
        while (dice >= PITY_TARGET) {
          dice -= PITY_TARGET;
          freeRemaining += PITY_AWARD;
          if (freeBet === 0) { freeBet = bet; acc = 1; }
        }
      }

      const spinInfo = db.prepare(
        `INSERT INTO spins (player_id, config_version, seed, mode, bet, total_cost, ante_enabled, total_win, win_tier, scatter_count, free_spins_awarded, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.id, cfgRow.version, seed, result.mode, bet, result.totalCost, anteEnabled ? 1 : 0,
        result.totalWin, result.winTier, result.scatterCount, result.freeSpinsAwarded,
        JSON.stringify(result),
      );
      const spinId = Number(spinInfo.lastInsertRowid);

      const insertTx = db.prepare(
        'INSERT INTO transactions (player_id, type, amount, balance_after, ref_spin_id) VALUES (?, ?, ?, ?, ?)',
      );
      if (result.totalCost > 0) insertTx.run(p.id, 'bet', -result.totalCost, p.balance - result.totalCost, spinId);
      if (result.totalWin > 0) insertTx.run(p.id, 'win', result.totalWin, balance, spinId);

      db.prepare(
        `UPDATE players SET balance = ?, free_spins_remaining = ?, free_spin_bet = ?,
         accumulated_multiplier = ?, dice_progress = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      ).run(balance, freeRemaining, freeBet, acc, dice, p.id);
    });
    run();

    const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(p.id) as PlayerRow;
    return { spin: result, state: playerState(updated) };
  });

  // ── 管理侧 ──

  app.post('/api/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (body.password !== adminPassword) {
      return reply.code(401).send(apiError('UNAUTHORIZED', '密码错误'));
    }
    const adminToken = randomBytes(24).toString('hex');
    adminTokens.add(adminToken);
    return { adminToken };
  });

  app.get('/api/admin/stats', async (req, reply) => {
    const token = bearer(req);
    if (!token || !adminTokens.has(token)) {
      return reply.code(401).send(apiError('UNAUTHORIZED', '需要管理员登录'));
    }
    const rows = db.prepare(
      `SELECT date(created_at) AS key,
              COUNT(*) AS spins,
              SUM(total_cost) AS totalBet,
              SUM(total_win) AS totalWin,
              CAST(SUM(total_win) AS REAL) / NULLIF(SUM(total_cost), 0) AS rtp,
              AVG(CASE WHEN total_win > 0 THEN 1.0 ELSE 0.0 END) AS hitRate,
              SUM(CASE WHEN free_spins_awarded > 0 AND mode = 'base' THEN 1 ELSE 0 END) AS fsTriggers,
              COUNT(DISTINCT player_id) AS uniquePlayers
       FROM spins GROUP BY date(created_at) ORDER BY key DESC LIMIT 30`,
    ).all();
    return { rows };
  });

  return app;
}
