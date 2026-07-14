import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
});

async function createSession() {
  const res = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; state: { balance: number; playerId: number } };
}

describe('游客会话', () => {
  it('创建游客：初始余额 10000 文', async () => {
    const { token, state } = await createSession();
    expect(token).toMatch(/^[0-9a-f]{32,}$/);
    expect(state.balance).toBe(10000);
  });

  it('带旧 token 幂等返回原账号', async () => {
    const a = await createSession();
    const res = await app.inject({ method: 'POST', url: '/api/session', payload: { token: a.token } });
    expect(res.json().state.playerId).toBe(a.state.playerId);
  });

  it('无 token 访问 /api/me → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/spin（服务端权威）', () => {
  it('余额守恒：balance = 10000 - totalCost + totalWin（含免费旋转不扣款）', async () => {
    const { token } = await createSession();
    let expected = 10000;
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/spin',
        headers: { authorization: `Bearer ${token}` },
        payload: { bet: 100, anteEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expected = expected - body.spin.totalCost + body.spin.totalWin;
      expect(body.state.balance).toBe(expected);
      expect(body.state.balance).toBeGreaterThanOrEqual(0);
      if (body.spin.mode === 'free') expect(body.spin.totalCost).toBe(0);
    }
  });

  it('非法注档 → 400；余额不足 → 402', async () => {
    const { token } = await createSession();
    const bad = await app.inject({
      method: 'POST', url: '/api/spin',
      headers: { authorization: `Bearer ${token}` },
      payload: { bet: 123, anteEnabled: false },
    });
    expect(bad.statusCode).toBe(400);

    // 烧光余额（最大注一直转，输光为止；防死循环上限 10000 次）
    let broke = false;
    for (let i = 0; i < 10000 && !broke; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/spin',
        headers: { authorization: `Bearer ${token}` },
        payload: { bet: 500, anteEnabled: false },
      });
      if (res.statusCode === 402) { broke = true; break; }
      expect(res.statusCode).toBe(200);
      // 免费旋转期间不会 402，继续
    }
    expect(broke).toBe(true);
  });

  it('spin 落库可审计：seed + 配置版本 + result_json 完整', async () => {
    const { token } = await createSession();
    await app.inject({
      method: 'POST', url: '/api/spin',
      headers: { authorization: `Bearer ${token}` },
      payload: { bet: 10, anteEnabled: false },
    });
    const db = app.slotsDb;
    const row = db.prepare('SELECT * FROM spins ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.seed).toBeTruthy();
    expect(row.config_version).toBe(1);
    const result = JSON.parse(row.result_json as string);
    expect(result.cascades.length).toBeGreaterThan(0);
  });

  it('流水对账：初始 + Σtransactions = 当前余额', async () => {
    const { token, state } = await createSession();
    for (let i = 0; i < 20; i++) {
      await app.inject({
        method: 'POST', url: '/api/spin',
        headers: { authorization: `Bearer ${token}` },
        payload: { bet: 50, anteEnabled: false },
      });
    }
    const db = app.slotsDb;
    const sum = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE player_id = ?')
      .get(state.playerId) as { s: number }).s;
    const balance = (db.prepare('SELECT balance FROM players WHERE id = ?')
      .get(state.playerId) as { balance: number }).balance;
    expect(10000 + sum).toBe(balance);
  });
});

describe('管理端', () => {
  it('错误密码 401，正确密码得 token，stats 需鉴权', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'wrong' } });
    expect(bad.statusCode).toBe(401);

    const noAuth = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(noAuth.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' } });
    expect(ok.statusCode).toBe(200);
    const { adminToken } = ok.json();

    const stats = await app.inject({
      method: 'GET', url: '/api/admin/stats',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toHaveProperty('rows');
  });
});

describe('GET /api/config', () => {
  it('返回公开配置：注档与当前版本', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.betLevels).toEqual([10, 20, 50, 100, 200, 500]);
    expect(body.version).toBe(1);
    expect(body.maxWinX).toBe(5000);
  });
});
