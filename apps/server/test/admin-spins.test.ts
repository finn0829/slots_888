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

async function spinOnce(token: string, bet = 10) {
  const res = await app.inject({
    method: 'POST', url: '/api/spin',
    headers: { authorization: `Bearer ${token}` }, payload: { bet },
  });
  return res.json();
}

describe('Spin 审计查询与回放校验（SRV-6b / ADM-4）', () => {
  it('未登录 → 401', async () => {
    for (const url of ['/api/admin/spins', '/api/admin/spins/1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('分页列表 + playerId 过滤 + winX 字段', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    for (let i = 0; i < 3; i++) await spinOnce(a.token, 10);
    await spinOnce(b.token, 50);

    const all = (await app.inject({ method: 'GET', url: '/api/admin/spins', headers: auth() })).json();
    expect(all.total).toBe(4);
    expect(all.spins[0].id).toBeGreaterThan(all.spins[1].id); // 倒序

    const onlyA = (await app.inject({ method: 'GET', url: `/api/admin/spins?playerId=${a.id}`, headers: auth() })).json();
    expect(onlyA.total).toBe(3);
    expect(onlyA.spins.every((s: { playerId: number }) => s.playerId === a.id)).toBe(true);
    const row = onlyA.spins[0];
    expect(row.winX).toBeCloseTo(row.totalWin / row.bet, 6);
    expect(row.cascades).toBeGreaterThanOrEqual(1);
  });

  it('minWinX 只留大奖', async () => {
    const a = await newPlayer();
    for (let i = 0; i < 30; i++) await spinOnce(a.token, 10);
    const res = (await app.inject({ method: 'GET', url: '/api/admin/spins?minWinX=1', headers: auth() })).json();
    expect(res.spins.every((s: { winX: number }) => s.winX >= 1)).toBe(true);
    expect(res.total).toBeLessThan(30);
  });

  it('单局详情：replayCheck.match = true；篡改落库结果后 = false', async () => {
    const a = await newPlayer();
    await spinOnce(a.token, 10);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/spins', headers: auth() })).json();
    const id = list.spins[0].id;

    const detail = (await app.inject({ method: 'GET', url: `/api/admin/spins/${id}`, headers: auth() })).json();
    expect(detail.spin.id).toBe(id);
    expect(detail.result.cascades.length).toBeGreaterThanOrEqual(1);
    expect(detail.replayCheck.match).toBe(true);

    // 篡改：把 totalWin 改大 —— 审计必须发现
    app.slotsDb.prepare(
      "UPDATE spins SET result_json = json_set(result_json, '$.totalWin', 999999) WHERE id = ?",
    ).run(id);
    const tampered = (await app.inject({ method: 'GET', url: `/api/admin/spins/${id}`, headers: auth() })).json();
    expect(tampered.replayCheck.match).toBe(false);

    // 不存在 → 404
    const nf = await app.inject({ method: 'GET', url: '/api/admin/spins/999999', headers: auth() });
    expect(nf.statusCode).toBe(404);
  });
});
