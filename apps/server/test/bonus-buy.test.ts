import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
  token = (await app.inject({ method: 'POST', url: '/api/session', payload: {} })).json().token;
});

const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const buy = (bet: number) => app.inject({ method: 'POST', url: '/api/bonus-buy', headers: auth(), payload: { bet } });
const spin = (bet: number, anteEnabled: boolean) =>
  app.inject({ method: 'POST', url: '/api/spin', headers: auth(), payload: { bet, anteEnabled } });

/** 把生效配置的 bonusBuy.enabled 改掉（模拟后台关闭买入后发布） */
function setBonusBuyEnabled(enabled: boolean) {
  const row = app.slotsDb.prepare("SELECT config_json FROM game_configs WHERE status='published'").get() as { config_json: string };
  const cfg = JSON.parse(row.config_json);
  cfg.bonusBuy.enabled = enabled;
  app.slotsDb.prepare("UPDATE game_configs SET config_json = ? WHERE status='published'").run(JSON.stringify(cfg));
}

describe('Bonus Buy（SRV-11 / ENG-8）', () => {
  it('/api/config 下发 bonusBuy { enabled, costMultiplier }（服务端实算，非写死）', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg.bonusBuy).toBeDefined();
    expect(cfg.bonusBuy.enabled).toBe(true);
    // 默认档 rtp965 标定值 44.30；买入价约 44× 注
    expect(cfg.bonusBuy.costMultiplier).toBeGreaterThan(40);
    expect(cfg.bonusBuy.costMultiplier).toBeLessThan(50);
  });

  it('买入成功：扣款 round(倍数×注)、置 10 次免费旋转、锁注、倍数归 1、落 bonus_buy 流水', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    const cost = Math.round(100 * cfg.bonusBuy.costMultiplier);

    const res = await buy(100);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cost).toBe(cost);
    expect(body.freeSpinsAwarded).toBe(10);
    expect(body.state.balance).toBe(10000 - cost);
    expect(body.state.freeSpinsRemaining).toBe(10);
    expect(body.state.freeSpinBet).toBe(100);
    expect(body.state.accumulatedMultiplier).toBe(1);

    const tx = app.slotsDb.prepare("SELECT type, amount, balance_after FROM transactions WHERE type='bonus_buy'").get() as
      { type: string; amount: number; balance_after: number };
    expect(tx.amount).toBe(-cost);
    expect(tx.balance_after).toBe(10000 - cost);
  });

  it('余额不足拒绝（402），且状态不变', async () => {
    app.slotsDb.prepare('UPDATE players SET balance = 100').run();
    const res = await buy(100);
    expect(res.statusCode).toBe(402);
    const p = app.slotsDb.prepare('SELECT balance, free_spins_remaining FROM players').get() as { balance: number; free_spins_remaining: number };
    expect(p.balance).toBe(100);
    expect(p.free_spins_remaining).toBe(0);
  });

  it('封禁玩家拒绝（403）', async () => {
    app.slotsDb.prepare("UPDATE players SET status='banned'").run();
    expect((await buy(100)).statusCode).toBe(403);
  });

  it('后台关闭 Bonus Buy 后拒绝买入（403 BONUS_BUY_DISABLED）', async () => {
    setBonusBuyEnabled(false);
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg.bonusBuy.enabled).toBe(false);
    const res = await buy(100);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BONUS_BUY_DISABLED');
  });

  it('非法注档拒绝（400）', async () => {
    expect((await buy(37)).statusCode).toBe(400);
  });

  it('已有免费旋转时拒绝重复买入（409）', async () => {
    app.slotsDb.prepare('UPDATE players SET free_spins_remaining = 3, free_spin_bet = 50, accumulated_multiplier = 2').run();
    expect((await buy(100)).statusCode).toBe(409);
  });

  it('买入后 Ante 被强制关：接着 spin 一律 free/0 扣款/anteEnabled=false', async () => {
    await buy(100);
    const res = await spin(100, true); // 请求里带 ante，服务端应忽略
    const body = res.json();
    expect(body.spin.mode).toBe('free');
    expect(body.spin.totalCost).toBe(0);
    expect(body.spin.anteEnabled).toBe(false);
  });

  it('个人统计对账：买入花费计入总投入，买来的免费旋转赢奖计入总赢，RTP 自洽', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    const cost = Math.round(100 * cfg.bonusBuy.costMultiplier);
    await buy(100);
    // 把 10 次免费旋转打完
    let freeWin = 0;
    for (let i = 0; i < 40; i++) {
      const r = (await spin(100, false)).json();
      if (r.spin.mode === 'free') freeWin += r.spin.totalWin;
      if (r.state.freeSpinsRemaining === 0) break;
    }
    const stats = (await app.inject({ method: 'GET', url: '/api/stats', headers: auth() })).json();
    expect(stats.bonusBuySpent).toBe(cost);
    // 总投入 = 免费旋转 total_cost(=0) 之和 + 买入价 = 买入价
    expect(stats.totalBet).toBe(cost);
    expect(stats.totalWin).toBe(freeWin);
    expect(stats.rtp).toBeCloseTo(freeWin / cost, 6);
    expect(stats.net).toBe(freeWin - cost);
  });

  it('余额守恒：买入后混转，流水加总 = 余额变化', async () => {
    await buy(100);
    for (let i = 0; i < 30; i++) {
      const r = await spin(100, false);
      if (r.statusCode !== 200) break;
      if (r.json().state.freeSpinsRemaining === 0) {
        // 免费旋转打完后继续几把基础局
        await spin(50, false);
      }
    }
    const sum = (app.slotsDb.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions').get() as { s: number }).s;
    const balance = (app.slotsDb.prepare('SELECT balance FROM players').get() as { balance: number }).balance;
    expect(10000 + sum).toBe(balance);
  });
});
