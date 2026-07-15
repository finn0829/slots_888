import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  anteSpeedup, freeSpinTriggerRate, getPreset, simulate, spin,
  type GameConfig, type SpinResult,
} from '@slots/engine';
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
const MIN_BET = BET_LEVELS[0]!;

// 经济缓冲参数（SRV-7）：默认值即需求池经济数值表；运行时可被 settings 表覆盖（ADM-7）
export interface EconomyParams {
  dailyBonus: number;
  reliefAmount: number;
  reliefCooldownHours: number;
}
const ECONOMY_DEFAULTS: EconomyParams = { dailyBonus: 1000, reliefAmount: 2000, reliefCooldownHours: 4 };
const ECONOMY_MAX_COOLDOWN_HOURS = 168;

interface PlayerRow {
  id: number;
  token: string;
  balance: number;
  status: 'active' | 'banned';
  free_spins_remaining: number;
  free_spin_bet: number;
  accumulated_multiplier: number;
  dice_progress: number;
  last_daily_claim_at: string | null;
  last_relief_at: string | null;
}

/** 签到按 UTC 日界；同一天只能领一次 */
function canClaimDaily(p: PlayerRow): boolean {
  if (!p.last_daily_claim_at) return true;
  return p.last_daily_claim_at.slice(0, 10) !== new Date().toISOString().slice(0, 10);
}

/** 破产补币：余额不够最低注，且冷却已过 */
function canClaimRelief(p: PlayerRow, eco: EconomyParams): boolean {
  if (p.balance >= MIN_BET) return false;
  if (p.free_spins_remaining > 0) return false; // 还有免费旋转可打，不算破产
  if (!p.last_relief_at) return true;
  const elapsed = Date.now() - new Date(`${p.last_relief_at.replace(' ', 'T')}Z`).getTime();
  return elapsed >= eco.reliefCooldownHours * 3600_000;
}

function playerState(p: PlayerRow, eco: EconomyParams) {
  return {
    playerId: p.id,
    balance: p.balance,
    freeSpinsRemaining: p.free_spins_remaining,
    freeSpinBet: p.free_spin_bet,
    accumulatedMultiplier: p.accumulated_multiplier,
    diceProgress: p.dice_progress,
    status: p.status,
    canClaimDaily: canClaimDaily(p),
    canClaimRelief: canClaimRelief(p, eco),
  };
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // 空 body + content-type: application/json 不应报 400（publish/rollback 等无参 POST）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    if (body === '') return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { done(e as Error, undefined); }
  });
  const db = openDb(opts.dbPath ?? process.env.SLOTS_DB ?? 'data/slots.db');
  app.decorate('slotsDb', db);
  const adminPassword = opts.adminPassword ?? process.env.SLOTS_ADMIN_PASSWORD ?? 'admin888';
  const adminTokens = new Set<string>();

  const getPlayerByToken = db.prepare('SELECT * FROM players WHERE token = ?');
  const getPublished = db.prepare("SELECT version, config_json, estimated_rtp FROM game_configs WHERE status = 'published' ORDER BY version DESC LIMIT 1");

  /** 经济参数：settings 表覆盖默认值（缺 key 或缺字段都回退默认） */
  function getEconomy(): EconomyParams {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'economy'").get() as { value: string } | undefined;
    if (!row) return { ...ECONOMY_DEFAULTS };
    return { ...ECONOMY_DEFAULTS, ...(JSON.parse(row.value) as Partial<EconomyParams>) };
  }

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
      if (existing) return { token: existing.token, state: playerState(existing, getEconomy()) };
    }
    const token = randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO players (token, balance) VALUES (?, ?)').run(token, INITIAL_BALANCE);
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid) as PlayerRow;
    return { token, state: playerState(p, getEconomy()) };
  });

  app.get('/api/me', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    return { state: playerState(p, getEconomy()) };
  });

  app.get('/api/config', async () => {
    const row = getPublished.get() as { version: number; config_json: string; estimated_rtp: number | null };
    const cfg = JSON.parse(row.config_json) as GameConfig;
    return {
      version: row.version,
      betLevels: BET_LEVELS,
      // 公示 RTP：管理员改过权重的版本以模拟器估算值为准（此时预设的标定值已失效），
      // 否则用该配置的标定值。前端一律照此渲染，不得写死——写死的数字改一次配置就成了谎言。
      rtp: row.estimated_rtp ?? cfg.nominalRtp,
      paytable: Object.fromEntries(
        Object.entries(cfg.symbols).map(([s, v]) => [s, v.pay.map((x) => x * cfg.payoutScale)]),
      ),
      // 触发率解析计算（非硬编码），后台改权重后公示数字自动同步，不会变成谎言
      anteRule: {
        costMultiplier: cfg.anteCostMultiplier,
        triggerRate: freeSpinTriggerRate(cfg, false),
        anteTriggerRate: freeSpinTriggerRate(cfg, true),
        speedup: anteSpeedup(cfg),
      },
      freeSpins: cfg.freeSpins,
      maxWinX: cfg.maxWinX,
      pity: { target: PITY_TARGET, award: PITY_AWARD },
      // Bonus Buy（ENG-8）：开关 + 买入价倍数，均由当前生效配置下发。
      // 前端展示「花 N× 买入（= X 文）」全用这个 costMultiplier，绝不写死——改配置就跟着变。
      bonusBuy: { enabled: cfg.bonusBuy.enabled, costMultiplier: cfg.bonusBuy.costMultiplier },
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
    return { spin: result, state: playerState(updated, getEconomy()) };
  });

  // ── Bonus Buy（SRV-11 / ENG-8）：花钱直接买 PITY_AWARD 次免费旋转 ──
  // 买入价按「买入档 RTP ≈ 该档公示 RTP」标定（见 engine bonusbuy-calibrate.ts）。
  // 服务端权威：校验开关/封禁/余额，扣款走 bonus_buy 流水（计入玩家总投入，不污染赢奖），
  // 置免费旋转状态 = 10 次 + Ante 强制关，之后玩家用 /api/spin 打完（复用 WEB-18 流程）。
  app.post('/api/bonus-buy', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    if (p.status === 'banned') return reply.code(403).send(apiError('BANNED', '账号已被封禁'));
    if (p.free_spins_remaining > 0) {
      return reply.code(409).send(apiError('CONFLICT', '还有免费旋转没打完，先打完再买'));
    }

    const cfgRow = getPublished.get() as { version: number; config_json: string };
    const config = JSON.parse(cfgRow.config_json) as GameConfig;
    if (!config.bonusBuy.enabled) {
      return reply.code(403).send(apiError('BONUS_BUY_DISABLED', '当前未开放买入免费旋转'));
    }

    const body = (req.body ?? {}) as { bet?: number };
    const bet = Number(body.bet);
    if (!BET_LEVELS.includes(bet)) {
      return reply.code(400).send(apiError('BAD_REQUEST', `非法注档: ${body.bet}，可用 ${BET_LEVELS.join('/')}`));
    }
    const cost = Math.round(bet * config.bonusBuy.costMultiplier);
    if (p.balance < cost) {
      return reply.code(402).send(apiError('INSUFFICIENT_BALANCE', '余额不足以买入'));
    }

    db.transaction(() => {
      const after = p.balance - cost;
      db.prepare(
        `UPDATE players SET balance = ?, free_spins_remaining = ?, free_spin_bet = ?,
         accumulated_multiplier = 1, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      ).run(after, PITY_AWARD, bet, p.id);
      // Ante 与买入无关：免费旋转本就忽略 ante，不写 ante 状态。
      db.prepare(
        "INSERT INTO transactions (player_id, type, amount, balance_after, note) VALUES (?, 'bonus_buy', ?, ?, ?)",
      ).run(p.id, -cost, after, `买入 ${PITY_AWARD} 次免费旋转（注 ${bet}）`);
    })();

    const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(p.id) as PlayerRow;
    return { cost, freeSpinsAwarded: PITY_AWARD, state: playerState(updated, getEconomy()) };
  });

  // ── 玩家个人统计（SRV-10）：数据全部来自 spins/transactions，与后台看板同源可对账 ──

  /** 断线重连：最后一局的完整 SpinResult，供前端恢复盘面（纯展示，不产生判定） */
  app.get('/api/last-spin', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    const row = db.prepare(
      'SELECT result_json FROM spins WHERE player_id = ? ORDER BY id DESC LIMIT 1',
    ).get(p.id) as { result_json: string } | undefined;
    return { spin: row ? (JSON.parse(row.result_json) as unknown) : null };
  });

  // 赢奖历史（WEB-14）：最近若干局，游标分页，含终盘盘面供前端展开
  const HISTORY_DEFAULT_LIMIT = 20;
  const HISTORY_MAX_LIMIT = 50;
  app.get('/api/history', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    const q = req.query as { before?: string; limit?: string };
    let limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit <= 0) limit = HISTORY_DEFAULT_LIMIT;
    limit = Math.min(limit, HISTORY_MAX_LIMIT);
    const before = Number(q.before);
    const hasCursor = Number.isInteger(before) && before > 0;

    const rows = db.prepare(
      `SELECT id, mode, bet, total_cost, total_win, win_tier, created_at, result_json
       FROM spins
       WHERE player_id = ?${hasCursor ? ' AND id < ?' : ''}
       ORDER BY id DESC LIMIT ?`,
    ).all(...(hasCursor ? [p.id, before, limit] : [p.id, limit])) as Array<{
      id: number; mode: 'base' | 'free'; bet: number; total_cost: number;
      total_win: number; win_tier: string | null; created_at: string; result_json: string;
    }>;

    const history = rows.map((r) => {
      const stored = JSON.parse(r.result_json) as SpinResult;
      return {
        spinId: r.id,
        createdAt: r.created_at,
        mode: r.mode,
        isFree: r.mode === 'free',
        bet: r.bet,
        totalCost: r.total_cost,
        totalWin: r.total_win,
        winX: r.bet > 0 ? r.total_win / r.bet : 0,
        winTier: r.win_tier,
        finalGrid: stored.cascades.at(-1)!.gridAfter,
      };
    });
    // 本页满 limit ⇒ 可能还有更早的；不足则到底了
    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { history, nextCursor };
  });

  app.get('/api/stats', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));

    const s = db.prepare(
      `SELECT COUNT(*)                                            AS totalSpins,
              COALESCE(SUM(total_cost), 0)                        AS totalBet,
              COALESCE(SUM(total_win), 0)                         AS totalWin,
              COALESCE(MAX(total_win), 0)                         AS biggestWin,
              COALESCE(MAX(CAST(total_win AS REAL) / NULLIF(bet, 0)), 0) AS biggestWinX,
              COALESCE(SUM(CASE WHEN mode = 'free' THEN 1 ELSE 0 END), 0) AS freeSpinsPlayed,
              COALESCE(SUM(CASE WHEN total_win > 0 THEN 1 ELSE 0 END), 0) AS winningSpins
       FROM spins WHERE player_id = ?`,
    ).get(p.id) as {
      totalSpins: number; totalBet: number; totalWin: number;
      biggestWin: number; biggestWinX: number; freeSpinsPlayed: number; winningSpins: number;
    };

    // 补贴（签到/救济/管理补币）单列，不混进"赢来的钱"
    const bonus = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS received FROM transactions
       WHERE player_id = ? AND type IN ('daily_bonus','bankrupt_relief','loss_rebate','admin_credit')`,
    ).get(p.id) as { received: number };

    // Bonus Buy 买入花费计入「总投入」：买来的免费旋转赢奖已在 spins.total_win（分子），
    // 买入价必须进分母，个人实测 RTP 才自洽（amount 为负，取相反数为花费）。
    const buy = db.prepare(
      "SELECT COALESCE(-SUM(amount), 0) AS spent FROM transactions WHERE player_id = ? AND type = 'bonus_buy'",
    ).get(p.id) as { spent: number };

    const totalBet = s.totalBet + buy.spent;
    return {
      totalSpins: s.totalSpins,
      totalBet,
      totalWin: s.totalWin,
      net: s.totalWin - totalBet,
      rtp: totalBet > 0 ? s.totalWin / totalBet : null,
      hitRate: s.totalSpins > 0 ? s.winningSpins / s.totalSpins : null,
      biggestWin: s.biggestWin,
      biggestWinX: s.biggestWinX,
      freeSpinsPlayed: s.freeSpinsPlayed,
      bonusBuySpent: buy.spent,
      bonusReceived: bonus.received,
    };
  });

  // ── 经济缓冲（SRV-7）──

  /** 发币 + 记流水（原子） */
  const grant = db.transaction((p: PlayerRow, amount: number, type: 'daily_bonus' | 'bankrupt_relief', stampCol: 'last_daily_claim_at' | 'last_relief_at') => {
    const after = p.balance + amount;
    db.prepare(`UPDATE players SET balance = ?, ${stampCol} = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(after, p.id);
    db.prepare('INSERT INTO transactions (player_id, type, amount, balance_after) VALUES (?, ?, ?, ?)')
      .run(p.id, type, amount, after);
  });

  app.post('/api/claim-daily', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    if (p.status === 'banned') return reply.code(403).send(apiError('BANNED', '账号已被封禁'));
    if (!canClaimDaily(p)) return reply.code(409).send(apiError('CONFLICT', '今天已经签到过了，明天再来'));
    const eco = getEconomy();
    grant(p, eco.dailyBonus, 'daily_bonus', 'last_daily_claim_at');
    const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(p.id) as PlayerRow;
    return { amount: eco.dailyBonus, state: playerState(updated, eco) };
  });

  app.post('/api/claim-relief', async (req, reply) => {
    const p = requirePlayer(req);
    if (!p) return reply.code(401).send(apiError('UNAUTHORIZED', '缺少或无效的玩家 token'));
    if (p.status === 'banned') return reply.code(403).send(apiError('BANNED', '账号已被封禁'));
    const eco = getEconomy();
    if (!canClaimRelief(p, eco)) {
      const why = p.balance >= MIN_BET ? '余额还够玩，暂不能领取救济' : `救济金冷却中（每 ${eco.reliefCooldownHours} 小时一次）`;
      return reply.code(409).send(apiError('CONFLICT', why));
    }
    grant(p, eco.reliefAmount, 'bankrupt_relief', 'last_relief_at');
    const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(p.id) as PlayerRow;
    return { amount: eco.reliefAmount, state: playerState(updated, eco) };
  });

  // ── 管理侧 ──

  /** 管理动作留痕（SRV-9）：资金动作另有 transactions，这里记全部管理行为 */
  const logOp = (action: string, detail: unknown) => {
    db.prepare('INSERT INTO admin_ops (action, detail) VALUES (?, ?)').run(action, JSON.stringify(detail));
  };

  app.post('/api/admin/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (body.password !== adminPassword) {
      return reply.code(401).send(apiError('UNAUTHORIZED', '密码错误'));
    }
    const adminToken = randomBytes(24).toString('hex');
    adminTokens.add(adminToken);
    logOp('login', {});
    return { adminToken };
  });

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    const token = bearer(req);
    if (!token || !adminTokens.has(token)) {
      void reply.code(401).send(apiError('UNAUTHORIZED', '需要管理员登录'));
      return false;
    }
    return true;
  }

  interface ConfigRow {
    version: number; label: string; status: string;
    config_json: string; estimated_rtp: number | null;
    created_at: string; published_at: string | null;
  }
  const configMeta = (r: ConfigRow) => ({
    version: r.version, label: r.label, status: r.status,
    estimatedRtp: r.estimated_rtp, createdAt: r.created_at, publishedAt: r.published_at,
  });
  const getConfigRow = db.prepare('SELECT * FROM game_configs WHERE version = ?');

  app.get('/api/admin/configs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db.prepare('SELECT * FROM game_configs ORDER BY version DESC').all() as ConfigRow[];
    return { configs: rows.map(configMeta) };
  });

  app.get('/api/admin/configs/:version', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = getConfigRow.get(Number((req.params as { version: string }).version)) as ConfigRow | undefined;
    if (!row) return reply.code(404).send(apiError('NOT_FOUND', '版本不存在'));
    return { config: JSON.parse(row.config_json), meta: configMeta(row) };
  });

  // 新建草稿：从预设或从历史版本复制
  app.post('/api/admin/configs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { preset?: string; baseVersion?: number; label?: string; config?: GameConfig };
    let config: GameConfig;
    try {
      if (body.config) config = body.config;
      else if (body.baseVersion) {
        const base = getConfigRow.get(body.baseVersion) as ConfigRow | undefined;
        if (!base) return reply.code(404).send(apiError('NOT_FOUND', '基准版本不存在'));
        config = JSON.parse(base.config_json);
      } else config = getPreset(body.preset ?? 'rtp965');
    } catch (e) {
      return reply.code(400).send(apiError('BAD_REQUEST', (e as Error).message));
    }
    const next = ((db.prepare('SELECT MAX(version) v FROM game_configs').get() as { v: number }).v ?? 0) + 1;
    db.prepare("INSERT INTO game_configs (version, label, status, config_json) VALUES (?, ?, 'draft', ?)")
      .run(next, body.label ?? `草稿 v${next}`, JSON.stringify(config));
    return { meta: configMeta(getConfigRow.get(next) as ConfigRow) };
  });

  app.put('/api/admin/configs/:version', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const version = Number((req.params as { version: string }).version);
    const row = getConfigRow.get(version) as ConfigRow | undefined;
    if (!row) return reply.code(404).send(apiError('NOT_FOUND', '版本不存在'));
    if (row.status !== 'draft') return reply.code(409).send(apiError('CONFLICT', '只有草稿可以修改'));
    const body = (req.body ?? {}) as { config?: GameConfig; label?: string };
    if (!body.config) return reply.code(400).send(apiError('BAD_REQUEST', '缺少 config'));
    db.prepare('UPDATE game_configs SET config_json = ?, label = COALESCE(?, label), estimated_rtp = NULL WHERE version = ?')
      .run(JSON.stringify(body.config), body.label ?? null, version);
    return { meta: configMeta(getConfigRow.get(version) as ConfigRow) };
  });

  const publishTx = db.transaction((version: number) => {
    db.prepare("UPDATE game_configs SET status = 'retired' WHERE status = 'published'").run();
    db.prepare("UPDATE game_configs SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE version = ?").run(version);
  });

  app.post('/api/admin/configs/:version/publish', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const version = Number((req.params as { version: string }).version);
    const row = getConfigRow.get(version) as ConfigRow | undefined;
    if (!row) return reply.code(404).send(apiError('NOT_FOUND', '版本不存在'));
    if (row.status !== 'draft') return reply.code(409).send(apiError('CONFLICT', '只有草稿可以发布'));
    publishTx(version);
    logOp('config_publish', { version, label: row.label });
    return { meta: configMeta(getConfigRow.get(version) as ConfigRow) };
  });

  // 回滚 = 以历史版本复制出新版本并直接发布（留痕，不改写历史）
  app.post('/api/admin/configs/:version/rollback', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const version = Number((req.params as { version: string }).version);
    const row = getConfigRow.get(version) as ConfigRow | undefined;
    if (!row) return reply.code(404).send(apiError('NOT_FOUND', '版本不存在'));
    const next = ((db.prepare('SELECT MAX(version) v FROM game_configs').get() as { v: number }).v ?? 0) + 1;
    db.prepare("INSERT INTO game_configs (version, label, status, config_json, estimated_rtp) VALUES (?, ?, 'draft', ?, ?)")
      .run(next, `回滚自 v${version}（${row.label}）`, row.config_json, row.estimated_rtp);
    publishTx(next);
    logOp('config_rollback', { fromVersion: version, newVersion: next, label: row.label });
    return { meta: configMeta(getConfigRow.get(next) as ConfigRow) };
  });

  const MAX_SIM_SPINS = 300_000;
  app.post('/api/admin/simulate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { version?: number; config?: GameConfig; spins?: number };
    const spins = body.spins ?? 100_000;
    if (!Number.isInteger(spins) || spins < 1000 || spins > MAX_SIM_SPINS) {
      return reply.code(400).send(apiError('BAD_REQUEST', `spins 需在 1000–${MAX_SIM_SPINS} 之间`));
    }
    let config: GameConfig;
    if (body.config) config = body.config;
    else {
      const row = getConfigRow.get(body.version ?? -1) as ConfigRow | undefined;
      if (!row) return reply.code(404).send(apiError('NOT_FOUND', '版本不存在'));
      config = JSON.parse(row.config_json);
    }
    const s = simulate(config, { spins, seedPrefix: `admin-sim-${Date.now()}` });
    if (body.version) {
      db.prepare('UPDATE game_configs SET estimated_rtp = ? WHERE version = ?').run(s.rtp, body.version);
    }
    return {
      rtp: s.rtp, hitRate: s.hitRate, fsTriggerRate: s.fsTriggerRate,
      maxWinX: s.maxWinX, stdevX: s.stdevX, featureWinShare: s.featureWinShare,
      spins: s.spins, elapsedMs: s.elapsedMs,
    };
  });

  // ── Spin 审计查询与回放校验（SRV-6b）──

  const SPINS_PAGE_SIZE = 20;
  const SPIN_COLS = `id, player_id AS playerId, config_version AS configVersion, mode, bet,
    total_cost AS totalCost, total_win AS totalWin,
    CAST(total_win AS REAL) / NULLIF(bet, 0) AS winX, win_tier AS winTier,
    json_array_length(result_json, '$.cascades') AS cascades, created_at AS createdAt`;

  app.get('/api/admin/spins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = req.query as { playerId?: string; from?: string; to?: string; minWinX?: string; page?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.playerId) { conds.push('player_id = ?'); params.push(Number(q.playerId)); }
    if (q.from) { conds.push('created_at >= ?'); params.push(q.from); }
    if (q.to) { conds.push('created_at < ?'); params.push(q.to); }
    if (q.minWinX) { conds.push('CAST(total_win AS REAL) / NULLIF(bet, 0) >= ?'); params.push(Number(q.minWinX)); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM spins ${where}`).get(...params) as { total: number };
    const rows = db.prepare(
      `SELECT ${SPIN_COLS} FROM spins ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, SPINS_PAGE_SIZE, (page - 1) * SPINS_PAGE_SIZE);
    return { spins: rows, total };
  });

  app.get('/api/admin/spins/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare(`SELECT ${SPIN_COLS}, seed, result_json FROM spins WHERE id = ?`).get(id) as
      | ({ configVersion: number; mode: 'base' | 'free'; bet: number; seed: string; result_json: string } & Record<string, unknown>)
      | undefined;
    if (!row) return reply.code(404).send(apiError('NOT_FOUND', '记录不存在'));

    const stored = JSON.parse(row.result_json) as SpinResult;
    const match = replayMatches(row, stored);

    const { result_json: _omit, ...spinRow } = row;
    return { spin: spinRow, result: stored, replayCheck: { match } };
  });

  /** 回放比对：spin 是纯函数，free 局起始倍数 = 首个 cascade 的 chainMultiplier（必为 ladder 值）。逐字节比对。 */
  function replayMatches(
    row: { configVersion: number; mode: 'base' | 'free'; bet: number; seed: string },
    stored: SpinResult,
  ): boolean {
    const cfgRow = getConfigRow.get(row.configVersion) as ConfigRow;
    const replayed = spin({
      seed: row.seed,
      bet: row.bet,
      anteEnabled: stored.anteEnabled,
      mode: row.mode,
      accumulatedMultiplier: row.mode === 'free' ? (stored.cascades[0]?.chainMultiplier ?? 1) : undefined,
      config: JSON.parse(cfgRow.config_json) as GameConfig,
    });
    return JSON.stringify(replayed) === JSON.stringify(stored);
  }

  // ── 对账自检（SRV-13）──

  const HEALTH_SAMPLE = 25; // 最近 25 + 随机 25
  app.post('/api/admin/health-check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    // A 不变量 + B 流水链（逐玩家一次遍历同时算两项）
    const players = db.prepare('SELECT id, balance FROM players').all() as { id: number; balance: number }[];
    const txByPlayer = db.prepare('SELECT id, amount, balance_after FROM transactions WHERE player_id = ? ORDER BY id');
    const invariant = { ok: true, checked: players.length, violations: [] as { playerId: number; balance: number; expected: number }[] };
    const chain = { ok: true, checked: 0, violations: [] as { playerId: number; txId: number; expected: number; actual: number }[] };
    for (const p of players) {
      const txs = txByPlayer.all(p.id) as { id: number; amount: number; balance_after: number }[];
      let running = INITIAL_BALANCE;
      for (const t of txs) {
        chain.checked++;
        const expected = running + t.amount;
        if (t.balance_after !== expected) {
          chain.violations.push({ playerId: p.id, txId: t.id, expected, actual: t.balance_after });
        }
        running = t.balance_after; // 以实际值续算，一处断点不淹没后续
      }
      const expectedBalance = INITIAL_BALANCE + txs.reduce((s, t) => s + t.amount, 0);
      if (p.balance !== expectedBalance) {
        invariant.violations.push({ playerId: p.id, balance: p.balance, expected: expectedBalance });
      }
    }
    invariant.ok = invariant.violations.length === 0;
    chain.ok = chain.violations.length === 0;

    // C 抽样回放：最近 N + 随机 N（总数 ≤2N 时等于全量）
    type ReplayRow = { id: number; configVersion: number; mode: 'base' | 'free'; bet: number; seed: string; result_json: string };
    const COLS = 'id, config_version AS configVersion, mode, bet, seed, result_json';
    const recent = db.prepare(`SELECT ${COLS} FROM spins ORDER BY id DESC LIMIT ?`).all(HEALTH_SAMPLE) as ReplayRow[];
    const cutoff = recent.length ? recent[recent.length - 1]!.id : 0;
    const random = db.prepare(`SELECT ${COLS} FROM spins WHERE id < ? ORDER BY RANDOM() LIMIT ?`)
      .all(cutoff, HEALTH_SAMPLE) as ReplayRow[];
    const mismatches: number[] = [];
    for (const r of [...recent, ...random]) {
      if (!replayMatches(r, JSON.parse(r.result_json) as SpinResult)) mismatches.push(r.id);
    }
    const replayReport = { ok: mismatches.length === 0, sampled: recent.length + random.length, mismatches };

    // D 各配置版本实测 RTP vs 估算（附样本量，供人肉判读——噪声随样本变化）
    const rtp = db.prepare(
      `SELECT s.config_version AS version, COUNT(*) AS spins,
              CAST(SUM(s.total_win) AS REAL) / NULLIF(SUM(s.total_cost), 0) AS measured,
              g.estimated_rtp AS estimated
       FROM spins s JOIN game_configs g ON g.version = s.config_version
       GROUP BY s.config_version ORDER BY s.config_version`,
    ).all();

    const report = { ranAt: new Date().toISOString(), invariant, chain, replay: replayReport, rtp };
    logOp('health_check', {
      invariantOk: invariant.ok, chainOk: chain.ok, replayOk: replayReport.ok,
      players: invariant.checked, transactions: chain.checked, sampled: replayReport.sampled,
      violations: invariant.violations.length + chain.violations.length + mismatches.length,
    });
    return { report };
  });

  // ── 玩家管理（SRV-6a）──

  const PLAYERS_PAGE_SIZE = 20;
  const getPlayerById = db.prepare('SELECT * FROM players WHERE id = ?');

  app.get('/api/admin/players', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = req.query as { query?: string; page?: string };
    const page = Math.max(1, Number(q.page) || 1);
    // query：全数字 → id 精确；否则 token 前缀
    let where = '';
    const params: unknown[] = [];
    if (q.query?.trim()) {
      const s = q.query.trim();
      if (/^\d+$/.test(s)) { where = 'WHERE p.id = ?'; params.push(Number(s)); }
      else { where = "WHERE p.token LIKE ? || '%'"; params.push(s); }
    }
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM players p ${where}`).get(...params) as { total: number };
    const players = db.prepare(
      `SELECT p.id, p.balance, p.status, p.created_at AS createdAt, p.last_seen_at AS lastSeenAt,
              COALESCE(s.spins, 0) AS spins, COALESCE(s.totalBet, 0) AS totalBet, COALESCE(s.totalWin, 0) AS totalWin
       FROM players p
       LEFT JOIN (SELECT player_id, COUNT(*) spins, SUM(total_cost) totalBet, SUM(total_win) totalWin
                  FROM spins GROUP BY player_id) s ON s.player_id = p.id
       ${where}
       ORDER BY p.last_seen_at DESC NULLS LAST, p.id DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, PLAYERS_PAGE_SIZE, (page - 1) * PLAYERS_PAGE_SIZE);
    return { players, total };
  });

  /** 找玩家或 404；返回 null 表示已发送响应 */
  function requireTarget(req: FastifyRequest, reply: FastifyReply): PlayerRow | null {
    const id = Number((req.params as { id: string }).id);
    const row = getPlayerById.get(id) as PlayerRow | undefined;
    if (!row) { void reply.code(404).send(apiError('NOT_FOUND', '玩家不存在')); return null; }
    return row;
  }

  app.post('/api/admin/players/:id/credit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = requireTarget(req, reply);
    if (!target) return;
    const body = (req.body ?? {}) as { amount?: number; note?: string };
    if (!Number.isInteger(body.amount) || (body.amount as number) <= 0) {
      return reply.code(400).send(apiError('BAD_REQUEST', '补币金额须为正整数'));
    }
    const amount = body.amount as number;
    db.transaction(() => {
      const after = target.balance + amount;
      db.prepare('UPDATE players SET balance = ? WHERE id = ?').run(after, target.id);
      db.prepare('INSERT INTO transactions (player_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)')
        .run(target.id, 'admin_credit', amount, after, body.note ?? null);
      logOp('player_credit', { playerId: target.id, amount, note: body.note ?? null });
    })();
    const updated = getPlayerById.get(target.id) as PlayerRow;
    return { state: playerState(updated, getEconomy()) };
  });

  app.post('/api/admin/players/:id/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = requireTarget(req, reply);
    if (!target) return;
    db.transaction(() => {
      const delta = INITIAL_BALANCE - target.balance;
      db.prepare(
        `UPDATE players SET balance = ?, free_spins_remaining = 0, free_spin_bet = 0,
         accumulated_multiplier = 0, dice_progress = 0 WHERE id = ?`,
      ).run(INITIAL_BALANCE, target.id);
      db.prepare('INSERT INTO transactions (player_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)')
        .run(target.id, 'admin_reset', delta, INITIAL_BALANCE, '重置为初始状态');
      logOp('player_reset', { playerId: target.id, balanceBefore: target.balance });
    })();
    const updated = getPlayerById.get(target.id) as PlayerRow;
    return { state: playerState(updated, getEconomy()) };
  });

  for (const [action, status] of [['ban', 'banned'], ['unban', 'active']] as const) {
    app.post(`/api/admin/players/:id/${action}`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const target = requireTarget(req, reply);
      if (!target) return;
      db.prepare('UPDATE players SET status = ? WHERE id = ?').run(status, target.id);
      logOp(`player_${action}`, { playerId: target.id });
      const updated = getPlayerById.get(target.id) as PlayerRow;
      return { state: playerState(updated, getEconomy()) };
    });
  }

  // ── 玩家交易流水（ADM-5c）──

  const TX_PAGE_SIZE = 20;
  app.get('/api/admin/players/:id/transactions', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = requireTarget(req, reply);
    if (!target) return;
    const page = Math.max(1, Number((req.query as { page?: string }).page) || 1);
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM transactions WHERE player_id = ?')
      .get(target.id) as { total: number };
    const transactions = db.prepare(
      `SELECT id, type, amount, balance_after AS balanceAfter, ref_spin_id AS refSpinId, note, created_at AS createdAt
       FROM transactions WHERE player_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(target.id, TX_PAGE_SIZE, (page - 1) * TX_PAGE_SIZE);
    return { transactions, total };
  });

  app.get('/api/admin/economy', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { params: getEconomy() };
  });

  app.put('/api/admin/economy', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { params?: Partial<EconomyParams> };
    const p = body.params;
    const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
    if (!p || !isPosInt(p.dailyBonus) || !isPosInt(p.reliefAmount) || !isPosInt(p.reliefCooldownHours)
      || p.reliefCooldownHours > ECONOMY_MAX_COOLDOWN_HOURS) {
      return reply.code(400).send(apiError('BAD_REQUEST',
        `参数须为正整数，冷却 ≤${ECONOMY_MAX_COOLDOWN_HOURS} 小时`));
    }
    const before = getEconomy();
    const after: EconomyParams = { dailyBonus: p.dailyBonus, reliefAmount: p.reliefAmount, reliefCooldownHours: p.reliefCooldownHours };
    db.prepare("INSERT INTO settings (key, value) VALUES ('economy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(after));
    logOp('economy_update', { before, after });
    return { params: after };
  });

  const OPS_PAGE_SIZE = 50;
  app.get('/api/admin/ops', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = req.query as { type?: string; page?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const where = q.type ? 'WHERE action = ?' : '';
    const params = q.type ? [q.type] : [];
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM admin_ops ${where}`).get(...params) as { total: number };
    const rows = db.prepare(
      `SELECT id, action, detail, created_at AS createdAt FROM admin_ops ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, OPS_PAGE_SIZE, (page - 1) * OPS_PAGE_SIZE);
    return { ops: rows, total };
  });

  app.get('/api/admin/stats', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const groupBy = (req.query as { groupBy?: string }).groupBy ?? 'day';
    // 按日或按配置版本聚合，行结构一致（CT-2 StatRow）
    const keyExpr = groupBy === 'configVersion' ? "'v' || config_version" : 'date(created_at)';
    const rows = db.prepare(
      `SELECT ${keyExpr} AS key,
              COUNT(*) AS spins,
              SUM(total_cost) AS totalBet,
              SUM(total_win) AS totalWin,
              CAST(SUM(total_win) AS REAL) / NULLIF(SUM(total_cost), 0) AS rtp,
              AVG(CASE WHEN total_win > 0 THEN 1.0 ELSE 0.0 END) AS hitRate,
              SUM(CASE WHEN free_spins_awarded > 0 AND mode = 'base' THEN 1 ELSE 0 END) AS fsTriggers,
              COUNT(DISTINCT player_id) AS uniquePlayers
       FROM spins GROUP BY ${keyExpr} ORDER BY key DESC LIMIT 30`,
    ).all();
    return { rows };
  });

  const BIG_WIN_X = 50; // 大奖阈值（≥50× 注），summary 卡与审计口径一致
  app.get('/api/admin/stats/summary', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const todaySpins = db.prepare(
      `SELECT COUNT(*) AS spins,
              COALESCE(SUM(total_cost), 0) AS spinBet,
              COALESCE(SUM(total_win), 0) AS totalWin,
              COUNT(DISTINCT player_id) AS uniquePlayers,
              COALESCE(SUM(CASE WHEN total_win >= bet * ${BIG_WIN_X} THEN 1 ELSE 0 END), 0) AS bigWins
       FROM spins WHERE date(created_at) = date('now')`,
    ).get() as { spins: number; spinBet: number; totalWin: number; uniquePlayers: number; bigWins: number };
    // Bonus Buy 花费计入投入，否则买来的免费旋转赢奖会把看板 RTP 抬虚（概率诚实 / 对账不变量）
    const { buySpent } = db.prepare(
      "SELECT COALESCE(-SUM(amount), 0) AS buySpent FROM transactions WHERE type = 'bonus_buy' AND date(created_at) = date('now')",
    ).get() as { buySpent: number };
    const totalBet = todaySpins.spinBet + buySpent;
    const today = {
      spins: todaySpins.spins,
      totalBet,
      totalWin: todaySpins.totalWin,
      rtp: totalBet > 0 ? todaySpins.totalWin / totalBet : null,
      uniquePlayers: todaySpins.uniquePlayers,
      bigWins: todaySpins.bigWins,
    };
    const pub = db.prepare(
      "SELECT version, estimated_rtp, config_json FROM game_configs WHERE status = 'published' ORDER BY version DESC LIMIT 1",
    ).get() as { version: number; estimated_rtp: number | null; config_json: string };
    const { totalPlayers } = db.prepare('SELECT COUNT(*) AS totalPlayers FROM players').get() as { totalPlayers: number };
    // 与玩家侧公示同一条规则：跑过模拟器的版本用估算值，否则用配置的标定值（ENG-10）
    const theoreticalRtp = pub.estimated_rtp ?? (JSON.parse(pub.config_json) as GameConfig).nominalRtp;
    return { today, publishedVersion: pub.version, theoreticalRtp, totalPlayers };
  });

  app.get('/api/admin/stats/distributions', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const winTiers = db.prepare(
      `SELECT win_tier AS tier, COUNT(*) AS count, SUM(total_win) AS totalWin
       FROM spins WHERE win_tier IS NOT NULL GROUP BY win_tier`,
    ).all();
    const betLevels = db.prepare(
      'SELECT bet, COUNT(*) AS count FROM spins GROUP BY bet ORDER BY bet',
    ).all();
    const cascadeDepth = db.prepare(
      `SELECT json_array_length(result_json, '$.cascades') AS depth, COUNT(*) AS count
       FROM spins GROUP BY depth ORDER BY depth`,
    ).all();
    const fs = db.prepare(
      `SELECT CAST(SUM(CASE WHEN free_spins_awarded > 0 THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS rate
       FROM spins WHERE mode = 'base'`,
    ).get() as { rate: number | null };
    return { winTiers, betLevels, cascadeDepth, fsTriggerRate: fs.rate ?? 0 };
  });

  return app;
}
