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

async function spinN(token: string, n: number, bet = 10) {
  for (let i = 0; i < n; i++) {
    await app.inject({ method: 'POST', url: '/api/spin', headers: { authorization: `Bearer ${token}` }, payload: { bet } });
  }
}

async function runCheck() {
  const res = await app.inject({ method: 'POST', url: '/api/admin/health-check', headers: auth() });
  expect(res.statusCode).toBe(200);
  return res.json().report;
}

describe('对账自检（SRV-13 / ADM-9）', () => {
  it('未登录 → 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/admin/health-check' })).statusCode).toBe(401);
  });

  it('干净数据 → 四项全绿，运行记入 admin_ops', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    await spinN(a.token, 10);
    await spinN(b.token, 5, 20);
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: { authorization: `Bearer ${a.token}` } });

    const r = await runCheck();
    expect(r.invariant.ok).toBe(true);
    expect(r.invariant.checked).toBe(2);
    expect(r.invariant.violations).toEqual([]);
    expect(r.chain.ok).toBe(true);
    expect(r.chain.checked).toBeGreaterThanOrEqual(16); // 15×bet(+win) + 签到
    expect(r.replay.ok).toBe(true);
    expect(r.replay.sampled).toBeGreaterThanOrEqual(15); // 总数 ≤50 时全量覆盖
    expect(r.replay.mismatches).toEqual([]);
    expect(r.rtp.length).toBeGreaterThanOrEqual(1);
    expect(r.rtp[0].version).toBe(1);
    expect(r.rtp[0].spins).toBeGreaterThanOrEqual(15);

    const ops = (await app.inject({ method: 'GET', url: '/api/admin/ops?type=health_check', headers: auth() })).json();
    expect(ops.total).toBe(1);
  });

  it('篡改一笔流水金额 → 不变量与流水链都抓到，且定位到那一笔', async () => {
    const a = await newPlayer();
    await spinN(a.token, 5);
    const db = app.slotsDb;
    const tx = db.prepare("SELECT id FROM transactions WHERE player_id = ? AND type = 'bet' LIMIT 1").get(a.id) as { id: number };
    db.prepare('UPDATE transactions SET amount = amount - 100 WHERE id = ?').run(tx.id);

    const r = await runCheck();
    expect(r.invariant.ok).toBe(false);
    expect(r.invariant.violations.map((v: { playerId: number }) => v.playerId)).toContain(a.id);
    expect(r.chain.ok).toBe(false);
    expect(r.chain.violations.map((v: { txId: number }) => v.txId)).toContain(tx.id);
  });

  it('篡改一条 result_json → 抽样回放抓到该 spin', async () => {
    const a = await newPlayer();
    await spinN(a.token, 10);
    const db = app.slotsDb;
    const s = db.prepare('SELECT id FROM spins ORDER BY id LIMIT 1').get() as { id: number };
    db.prepare("UPDATE spins SET result_json = json_set(result_json, '$.totalWin', 999999) WHERE id = ?").run(s.id);

    const r = await runCheck();
    expect(r.replay.ok).toBe(false);
    expect(r.replay.mismatches).toContain(s.id);
  });
});
