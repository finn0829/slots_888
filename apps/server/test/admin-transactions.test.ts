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

describe('玩家交易流水（ADM-5c）', () => {
  it('未登录 → 401；玩家不存在 → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/players/1/transactions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/players/999/transactions', headers: auth() })).statusCode).toBe(404);
  });

  it('流水字段齐全、id 倒序，余额可从流水逐笔加出来', async () => {
    const a = await newPlayer();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/spin', headers: { authorization: `Bearer ${a.token}` }, payload: { bet: 10 } });
    }
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: { authorization: `Bearer ${a.token}` } });
    await app.inject({
      method: 'POST', url: `/api/admin/players/${a.id}/credit`, headers: auth(),
      payload: { amount: 500, note: '测试补币' },
    });

    const res = await app.inject({ method: 'GET', url: `/api/admin/players/${a.id}/transactions`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.total).toBeGreaterThanOrEqual(5); // 3×bet(+win) + daily_bonus + admin_credit

    const tx = j.transactions;
    // id 倒序
    for (let i = 1; i < tx.length; i++) expect(tx[i - 1].id).toBeGreaterThan(tx[i].id);
    // 最新一笔是补币，note 可见，balanceAfter 与玩家当前余额一致
    expect(tx[0].type).toBe('admin_credit');
    expect(tx[0].amount).toBe(500);
    expect(tx[0].note).toBe('测试补币');
    const bal = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${a.token}` } })).json().state.balance;
    expect(tx[0].balanceAfter).toBe(bal);
    // bet 流水带 refSpinId（可跳审计）
    const betTx = tx.find((t: { type: string }) => t.type === 'bet');
    expect(betTx.refSpinId).toBeGreaterThan(0);
    // 不变量：余额 == 初始 10000 + Σamount（total ≤ 20 时全量在第一页）
    if (j.total <= 20) {
      const sum = tx.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
      expect(10000 + sum).toBe(bal);
    }
  });

  it('分页：每页 20，第二页拿到剩余', async () => {
    const a = await newPlayer();
    // 25 笔签到做不到（冷却），用补币造 25 笔流水
    for (let i = 0; i < 25; i++) {
      await app.inject({ method: 'POST', url: `/api/admin/players/${a.id}/credit`, headers: auth(), payload: { amount: 1 + i } });
    }
    const p1 = (await app.inject({ method: 'GET', url: `/api/admin/players/${a.id}/transactions`, headers: auth() })).json();
    const p2 = (await app.inject({ method: 'GET', url: `/api/admin/players/${a.id}/transactions?page=2`, headers: auth() })).json();
    expect(p1.total).toBe(25);
    expect(p1.transactions.length).toBe(20);
    expect(p2.transactions.length).toBe(5);
    // 两页无重叠
    const ids = new Set([...p1.transactions, ...p2.transactions].map((t: { id: number }) => t.id));
    expect(ids.size).toBe(25);
  });
});
