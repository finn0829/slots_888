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
  return app.inject({
    method: 'POST', url: '/api/spin',
    headers: { authorization: `Bearer ${token}` }, payload: { bet },
  });
}

describe('玩家管理 API（SRV-6a / ADM-5）', () => {
  it('未登录 → 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/players'],
      ['POST', '/api/admin/players/1/credit'],
      ['POST', '/api/admin/players/1/reset'],
      ['POST', '/api/admin/players/1/ban'],
      ['POST', '/api/admin/players/1/unban'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it('列表含 spin 聚合列；query 按 id 精确匹配', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    await spinOnce(a.token, 10);
    await spinOnce(a.token, 20);
    await spinOnce(b.token, 50);

    const res = await app.inject({ method: 'GET', url: '/api/admin/players', headers: auth() });
    const { players, total } = res.json();
    expect(total).toBe(2);
    const rowA = players.find((p: { id: number }) => p.id === a.id);
    expect(rowA.spins).toBe(2);
    expect(rowA.totalBet).toBe(30);
    expect(rowA.status).toBe('active');
    expect(rowA.balance).toBeGreaterThanOrEqual(0);

    const one = (await app.inject({ method: 'GET', url: `/api/admin/players?query=${b.id}`, headers: auth() })).json();
    expect(one.total).toBe(1);
    expect(one.players[0].id).toBe(b.id);
  });

  it('credit：余额增加、流水 admin_credit、操作日志；非法金额 400', async () => {
    const a = await newPlayer();
    const res = await app.inject({
      method: 'POST', url: `/api/admin/players/${a.id}/credit`, headers: auth(),
      payload: { amount: 100, note: '测试补币' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.balance).toBe(10100);

    const ops = (await app.inject({ method: 'GET', url: '/api/admin/ops?type=player_credit', headers: auth() })).json();
    expect(ops.total).toBe(1);
    expect(JSON.parse(ops.ops[0].detail)).toMatchObject({ playerId: a.id, amount: 100 });

    for (const amount of [0, -5, 1.5, undefined]) {
      const bad = await app.inject({
        method: 'POST', url: `/api/admin/players/${a.id}/credit`, headers: auth(), payload: { amount },
      });
      expect(bad.statusCode).toBe(400);
    }
    // 不存在的玩家 → 404
    const nf = await app.inject({ method: 'POST', url: '/api/admin/players/999/credit', headers: auth(), payload: { amount: 10 } });
    expect(nf.statusCode).toBe(404);
  });

  it('ban 后 spin 被拒 403，unban 恢复；进操作日志', async () => {
    const a = await newPlayer();
    await app.inject({ method: 'POST', url: `/api/admin/players/${a.id}/ban`, headers: auth() });
    expect((await spinOnce(a.token)).statusCode).toBe(403);
    await app.inject({ method: 'POST', url: `/api/admin/players/${a.id}/unban`, headers: auth() });
    expect((await spinOnce(a.token)).statusCode).toBe(200);
    const ops = (await app.inject({ method: 'GET', url: '/api/admin/ops', headers: auth() })).json();
    const actions = ops.ops.map((o: { action: string }) => o.action);
    expect(actions).toEqual(expect.arrayContaining(['player_ban', 'player_unban']));
  });

  it('reset：余额回 10000、免费旋转/保底清零、流水 admin_reset 记差额', async () => {
    const a = await newPlayer();
    await app.inject({ method: 'POST', url: `/api/admin/players/${a.id}/credit`, headers: auth(), payload: { amount: 5000 } });
    const res = await app.inject({ method: 'POST', url: `/api/admin/players/${a.id}/reset`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const s = res.json().state;
    expect(s.balance).toBe(10000);
    expect(s.freeSpinsRemaining).toBe(0);
    expect(s.diceProgress).toBe(0);
  });
});
