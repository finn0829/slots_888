import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

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

/** 直插合成 spin 行（只喂统计口径，result_json 不参与告警计算） */
function insertSpins(playerId: number, n: number, bet: number, win: number) {
  const stmt = app.slotsDb.prepare(
    `INSERT INTO spins (player_id, config_version, seed, mode, bet, total_cost, ante_enabled, total_win, scatter_count, free_spins_awarded, result_json)
     VALUES (?, 1, 'synthetic', 'base', ?, ?, 0, ?, 0, 0, '{}')`,
  );
  for (let i = 0; i < n; i++) stmt.run(playerId, bet, bet, win);
}

async function getAlerts() {
  const res = await app.inject({ method: 'GET', url: '/api/admin/stats/summary', headers: auth() });
  expect(res.statusCode).toBe(200);
  return res.json().alerts as Array<{ kind: string } & Record<string, unknown>>;
}

describe('看板告警（SRV-14 / ADM-10）', () => {
  it('少量正常数据 → alerts 为空数组（不足 500 局不告警）', async () => {
    const a = await newPlayer();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/spin', headers: { authorization: `Bearer ${a.token}` }, payload: { bet: 10 } });
    }
    expect(await getAlerts()).toEqual([]);
  });

  it('rtp_deviation：600 局实测 RTP 2.0 远超理论 → 触发且带 se/样本量', async () => {
    const a = await newPlayer();
    insertSpins(a.id, 600, 10, 20); // 每局 2 倍回报，方差 0 → SE≈0，偏差必超 3σ
    const alerts = await getAlerts();
    const dev = alerts.find((x) => x.kind === 'rtp_deviation');
    expect(dev).toBeTruthy();
    expect(dev!.version).toBe(1);
    expect(dev!.spins).toBe(600);
    expect(dev!.measured).toBeCloseTo(2.0, 6);
    expect(typeof dev!.se).toBe('number');
  });

  it('big_single_win：今日单局 ≥1000× → 触发并带 spinId', async () => {
    const a = await newPlayer();
    insertSpins(a.id, 1, 10, 12000); // 1200×
    const alerts = await getAlerts();
    const big = alerts.find((x) => x.kind === 'big_single_win');
    expect(big).toBeTruthy();
    expect(big!.playerId).toBe(a.id);
    expect(big!.winX).toBe(1200);
    // 该玩家只有 1 局，不该同时触发 player_rtp / rtp_deviation（样本 <500）
    expect(alerts.find((x) => x.kind === 'player_rtp')).toBeUndefined();
    expect(alerts.find((x) => x.kind === 'rtp_deviation')).toBeUndefined();
  });

  it('player_rtp：玩家 500 局个人 RTP 1.6 → 触发；另一玩家高 RTP 但仅 50 局 → 不触发', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    insertSpins(a.id, 500, 10, 16);
    insertSpins(b.id, 50, 10, 30);
    const alerts = await getAlerts();
    const mine = alerts.filter((x) => x.kind === 'player_rtp');
    expect(mine.map((x) => x.playerId)).toContain(a.id);
    expect(mine.map((x) => x.playerId)).not.toContain(b.id);
    const hit = mine.find((x) => x.playerId === a.id)!;
    expect(hit.rtp).toBeCloseTo(1.6, 6);
    expect(hit.spins).toBe(500);
  });
});
