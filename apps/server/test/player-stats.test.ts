import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
  token = (await app.inject({ method: 'POST', url: '/api/session', payload: {} })).json().token;
});

const auth = () => ({ authorization: `Bearer ${token}` });
const stats = async () => (await app.inject({ method: 'GET', url: '/api/stats', headers: auth() })).json();
const spin = (bet: number) => app.inject({
  method: 'POST', url: '/api/spin', headers: auth(), payload: { bet, anteEnabled: false },
});

describe('玩家个人统计 GET /api/stats', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('新玩家：全部为 0，rtp 为 null（无投入不谈返奖率）', async () => {
    const s = await stats();
    expect(s.totalSpins).toBe(0);
    expect(s.totalBet).toBe(0);
    expect(s.totalWin).toBe(0);
    expect(s.net).toBe(0);
    expect(s.rtp).toBeNull();
    expect(s.biggestWin).toBe(0);
    expect(s.biggestWinX).toBe(0);
  });

  it('转 30 把后：投入/赢奖/净额/RTP 与 spins 表逐条对账', async () => {
    for (let i = 0; i < 30; i++) await spin(100);
    const s = await stats();
    const db = app.slotsDb;
    const row = db.prepare(
      'SELECT COUNT(*) n, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(total_win),0) win, COALESCE(MAX(total_win),0) best FROM spins',
    ).get() as { n: number; cost: number; win: number; best: number };

    expect(s.totalSpins).toBe(row.n);
    expect(s.totalBet).toBe(row.cost);
    expect(s.totalWin).toBe(row.win);
    expect(s.net).toBe(row.win - row.cost);
    expect(s.rtp).toBeCloseTo(row.win / row.cost, 6);
    expect(s.biggestWin).toBe(row.best);
  });

  it('免费旋转（totalCost=0）计入 totalSpins 与 totalWin，但不增加 totalBet', async () => {
    // 造一个免费旋转：直接给玩家 5 次免费局
    const db = app.slotsDb;
    db.prepare('UPDATE players SET free_spins_remaining = 3, free_spin_bet = 100, accumulated_multiplier = 1').run();
    const before = await stats();
    for (let i = 0; i < 3; i++) await spin(100);
    const after = await stats();

    expect(after.totalSpins).toBe(before.totalSpins + 3);
    expect(after.totalBet).toBe(before.totalBet); // 免费局不扣款
    expect(after.freeSpinsPlayed).toBe(3);
  });

  it('biggestWinX = 最大单局赢奖 ÷ 当时的注（不是当前注）', async () => {
    for (let i = 0; i < 40; i++) await spin(10);
    const s = await stats();
    const db = app.slotsDb;
    const best = db.prepare(
      'SELECT COALESCE(MAX(CAST(total_win AS REAL) / NULLIF(bet,0)), 0) x FROM spins',
    ).get() as { x: number };
    expect(s.biggestWinX).toBeCloseTo(best.x, 4);
  });

  it('净额为负时 net 是负数（诚实展示亏损）', async () => {
    for (let i = 0; i < 50; i++) await spin(100);
    const s = await stats();
    expect(s.net).toBe(s.totalWin - s.totalBet);
    // RTP < 1 时净额必为负
    if (s.rtp !== null && s.rtp < 1) expect(s.net).toBeLessThan(0);
  });

  it('签到/救济发的币不算进 totalWin（那不是赢来的）', async () => {
    await spin(100);
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    const s = await stats();
    const db = app.slotsDb;
    const win = (db.prepare('SELECT COALESCE(SUM(total_win),0) w FROM spins').get() as { w: number }).w;
    expect(s.totalWin).toBe(win);
    expect(s.bonusReceived).toBe(1000);
  });
});
