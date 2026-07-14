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

async function newPlayer(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
  return res.json().token;
}

describe('经济参数动态化（SRV-7 后台侧 / ADM-7）', () => {
  it('未登录 → 401', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const res = await app.inject({ method, url: '/api/admin/economy', payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it('GET 返回默认参数', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/economy', headers: auth() });
    expect(res.json().params).toEqual({ dailyBonus: 1000, reliefAmount: 2000, reliefCooldownHours: 4 });
  });

  it('PUT 修改后玩家签到实得新数额，且进操作日志（含前后值）', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/economy', headers: auth(),
      payload: { params: { dailyBonus: 500, reliefAmount: 2000, reliefCooldownHours: 4 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().params.dailyBonus).toBe(500);

    const token = await newPlayer();
    const claim = await app.inject({
      method: 'POST', url: '/api/claim-daily', headers: { authorization: `Bearer ${token}` },
    });
    expect(claim.json().amount).toBe(500);

    const ops = (await app.inject({ method: 'GET', url: '/api/admin/ops?type=economy_update', headers: auth() })).json();
    expect(ops.total).toBe(1);
    const detail = JSON.parse(ops.ops[0].detail);
    expect(detail.before.dailyBonus).toBe(1000);
    expect(detail.after.dailyBonus).toBe(500);
  });

  it('非法值一律 400：负数/零/非整数/冷却超上限', async () => {
    const bad = [
      { dailyBonus: -1, reliefAmount: 2000, reliefCooldownHours: 4 },
      { dailyBonus: 0, reliefAmount: 2000, reliefCooldownHours: 4 },
      { dailyBonus: 1.5, reliefAmount: 2000, reliefCooldownHours: 4 },
      { dailyBonus: 1000, reliefAmount: 2000, reliefCooldownHours: 169 },
      { dailyBonus: 1000, reliefAmount: 2000 },
    ];
    for (const params of bad) {
      const res = await app.inject({ method: 'PUT', url: '/api/admin/economy', headers: auth(), payload: { params } });
      expect(res.statusCode).toBe(400);
    }
    // 参数未被污染
    const res = await app.inject({ method: 'GET', url: '/api/admin/economy', headers: auth() });
    expect(res.json().params.dailyBonus).toBe(1000);
  });
});
