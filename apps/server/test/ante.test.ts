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
const spin = (bet: number, anteEnabled: boolean) => app.inject({
  method: 'POST', url: '/api/spin', headers: auth(), payload: { bet, anteEnabled },
});

describe('Ante Bet（WEB-10 / ENG-6b）', () => {
  it('/api/config 公示真实触发率与加速倍数（解析值，非硬编码）', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    const a = cfg.anteRule;
    expect(a.costMultiplier).toBe(1.25);
    // 基础 ≈ 1/152，ante ≈ 1/93
    expect(1 / a.triggerRate).toBeGreaterThan(130);
    expect(1 / a.triggerRate).toBeLessThan(175);
    expect(1 / a.anteTriggerRate).toBeGreaterThan(80);
    expect(1 / a.anteTriggerRate).toBeLessThan(105);
    // 加速倍数 = 两者之比
    expect(a.speedup).toBeCloseTo(a.anteTriggerRate / a.triggerRate, 6);
    expect(a.speedup).toBeGreaterThan(1.5);
  });

  it('开启 ante：扣款为注的 1.25 倍', async () => {
    const res = await spin(100, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().spin.totalCost).toBe(125);
    expect(res.json().spin.anteEnabled).toBe(true);
  });

  it('关闭 ante：扣款为注本身', async () => {
    const res = await spin(100, false);
    expect(res.json().spin.totalCost).toBe(100);
    expect(res.json().spin.anteEnabled).toBe(false);
  });

  it('余额判断按加价后的金额：余额 120 时 ante 注 100 应被拒（402）', async () => {
    app.slotsDb.prepare('UPDATE players SET balance = 120').run();
    const ante = await spin(100, true);
    expect(ante.statusCode).toBe(402);
    // 同样余额下不开 ante 可以转
    const plain = await spin(100, false);
    expect(plain.statusCode).toBe(200);
  });

  it('ante 标记落库（可审计）', async () => {
    await spin(50, true);
    const row = app.slotsDb.prepare('SELECT ante_enabled, total_cost FROM spins ORDER BY id DESC LIMIT 1')
      .get() as { ante_enabled: number; total_cost: number };
    expect(row.ante_enabled).toBe(1);
    expect(row.total_cost).toBe(63); // round(50 × 1.25)
  });

  it('免费旋转期间强制关闭 ante：不扣款、不加价', async () => {
    app.slotsDb.prepare('UPDATE players SET free_spins_remaining = 2, free_spin_bet = 100, accumulated_multiplier = 1').run();
    const before = (app.slotsDb.prepare('SELECT balance FROM players').get() as { balance: number }).balance;
    const res = await spin(100, true); // 请求里带 ante，服务端应忽略
    const body = res.json();
    expect(body.spin.mode).toBe('free');
    expect(body.spin.totalCost).toBe(0);
    expect(body.spin.anteEnabled).toBe(false);
    expect(body.state.balance).toBe(before + body.spin.totalWin);
  });

  it('余额守恒：ante 与非 ante 混转 40 把，流水对账无误', async () => {
    let expected = 10000;
    for (let i = 0; i < 40; i++) {
      const useAnte = i % 2 === 0;
      const res = await spin(50, useAnte);
      if (res.statusCode !== 200) break;
      const b = res.json();
      if (b.spin.mode === 'base') {
        expect(b.spin.totalCost).toBe(useAnte ? 63 : 50);
      }
      expected = expected - b.spin.totalCost + b.spin.totalWin;
      expect(b.state.balance).toBe(expected);
    }
    const sum = (app.slotsDb.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions').get() as { s: number }).s;
    const balance = (app.slotsDb.prepare('SELECT balance FROM players').get() as { balance: number }).balance;
    expect(10000 + sum).toBe(balance);
  });
});
