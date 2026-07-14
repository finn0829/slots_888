import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { defaultPreset } from '@slots/engine';

let app: FastifyInstance;
let adminToken: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' } });
  adminToken = res.json().adminToken;
});

const auth = () => ({ authorization: `Bearer ${adminToken}` });

async function newPlayer(): Promise<{ token: string; id: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
  const j = res.json();
  return { token: j.token, id: j.state.playerId };
}

async function spinN(token: string, n: number, bet = 10) {
  for (let i = 0; i < n; i++) {
    await app.inject({
      method: 'POST', url: '/api/spin',
      headers: { authorization: `Bearer ${token}` }, payload: { bet },
    });
  }
}

describe('统计聚合扩展（SRV-5 / ADM-3）', () => {
  it('未登录 → 401', async () => {
    for (const url of ['/api/admin/stats/summary', '/api/admin/stats/distributions', '/api/admin/stats?groupBy=configVersion']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('summary：今日数字与 spins 表一致，可复算', async () => {
    const a = await newPlayer();
    await spinN(a.token, 5, 10);
    const s = (await app.inject({ method: 'GET', url: '/api/admin/stats/summary', headers: auth() })).json();
    expect(s.today.spins).toBe(5);
    expect(s.today.totalBet).toBe(50);
    expect(s.today.uniquePlayers).toBe(1);
    if (s.today.totalBet > 0) {
      expect(s.today.rtp).toBeCloseTo(s.today.totalWin / s.today.totalBet, 6);
    }
    expect(s.publishedVersion).toBe(1);
    // 理论 RTP = 生效配置的标定值（ENG-10 重校；曾硬编码为旧直测值 0.9558）
    expect(s.theoreticalRtp).toBeCloseTo(defaultPreset().nominalRtp, 4);
    expect(s.totalPlayers).toBe(1);
  });

  it('groupBy=configVersion：发布 v2 再转 → 两行，key 为 v1/v2', async () => {
    const a = await newPlayer();
    await spinN(a.token, 3);
    await app.inject({ method: 'POST', url: '/api/admin/configs', headers: auth(), payload: { preset: 'rtp92' } });
    await app.inject({ method: 'POST', url: '/api/admin/configs/2/publish', headers: auth() });
    await spinN(a.token, 2);

    const res = (await app.inject({ method: 'GET', url: '/api/admin/stats?groupBy=configVersion', headers: auth() })).json();
    const keys = res.rows.map((r: { key: string }) => r.key).sort();
    expect(keys).toEqual(['v1', 'v2']);
    const v1 = res.rows.find((r: { key: string }) => r.key === 'v1');
    expect(v1.spins).toBe(3);
  });

  it('distributions：各分布加总与总 spin 数对账', async () => {
    const a = await newPlayer();
    await spinN(a.token, 20, 10);
    const d = (await app.inject({ method: 'GET', url: '/api/admin/stats/distributions', headers: auth() })).json();

    // 注意：基础局可能触发免费旋转，spins 总行数 ≥ 20 —— 分布之间互相对账而不是写死 20
    const betSum = d.betLevels.reduce((s: number, r: { count: number }) => s + r.count, 0);
    const cascadeSum = d.cascadeDepth.reduce((s: number, r: { count: number }) => s + r.count, 0);
    expect(betSum).toBeGreaterThanOrEqual(20);
    expect(cascadeSum).toBe(betSum);
    // winTiers 只包含中奖档，count ≤ 总数；档位名合法
    const tiers = ['peng', 'gang', 'hu', 'zimo', 'tianhu'];
    expect(d.winTiers.every((r: { tier: string }) => tiers.includes(r.tier))).toBe(true);
    expect(typeof d.fsTriggerRate).toBe('number');
  });
});
