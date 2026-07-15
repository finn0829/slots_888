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
const spin = (bet = 100) => app.inject({
  method: 'POST', url: '/api/spin', headers: auth(), payload: { bet, anteEnabled: false },
});
const history = (qs = '') => app.inject({ method: 'GET', url: `/api/history${qs}`, headers: auth() });

/** 管理补币，避免测试中破产打断连转 */
async function topUp(playerId: number) {
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' },
  })).json().adminToken;
  await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/credit`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { amount: 1_000_000 },
  });
}

describe('GET /api/history（WEB-14 赢奖历史）', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history' });
    expect(res.statusCode).toBe(401);
  });

  it('新玩家 → 空数组，nextCursor 为 null', async () => {
    const res = await history();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('按 id 降序返回，字段与 spins 表逐条对账', async () => {
    for (let i = 0; i < 5; i++) await spin(100);
    const rows = history().then((r) => r.json().history);
    const body = await rows;
    expect(body).toHaveLength(5);
    // 降序
    const ids = body.map((r: any) => r.spinId);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    const db = app.slotsDb;
    for (const row of body) {
      const dbRow = db.prepare(
        `SELECT id, mode, bet, total_cost, total_win, win_tier, created_at, result_json
         FROM spins WHERE id = ?`,
      ).get(row.spinId) as any;
      expect(row.bet).toBe(dbRow.bet);
      expect(row.totalCost).toBe(dbRow.total_cost);
      expect(row.totalWin).toBe(dbRow.total_win);
      expect(row.mode).toBe(dbRow.mode);
      expect(row.isFree).toBe(dbRow.mode === 'free');
      expect(row.winTier).toBe(dbRow.win_tier);
      expect(row.createdAt).toBe(dbRow.created_at);
      expect(row.winX).toBeCloseTo(dbRow.total_win / dbRow.bet, 6);
      // finalGrid = result_json 末个 cascade 的 gridAfter
      const stored = JSON.parse(dbRow.result_json);
      expect(row.finalGrid).toEqual(stored.cascades.at(-1).gridAfter);
    }
  });

  it('finalGrid 是可直接上盘的 6×5 终盘', async () => {
    await spin(100);
    const row = (await history()).json().history[0];
    expect(row.finalGrid).toHaveLength(6);
    for (const col of row.finalGrid) {
      expect(col).toHaveLength(5);
      for (const cell of col) expect(typeof cell.symbol).toBe('string');
    }
  });

  it('默认 limit 20', async () => {
    const first = (await spin(100)).json();
    await topUp(first.state.playerId);
    for (let i = 0; i < 24; i++) await spin(100);
    const body = (await history()).json();
    expect(body.history).toHaveLength(20);
    expect(body.nextCursor).toBe(body.history[19].spinId);
  });

  it('limit 上限 50（超出截断）', async () => {
    const first = (await spin(100)).json();
    await topUp(first.state.playerId);
    for (let i = 0; i < 59; i++) await spin(100);
    const body = (await history('?limit=100')).json();
    expect(body.history).toHaveLength(50);
  });

  it('游标分页：before = 上一页最后一条 id，翻到更早且无重叠', async () => {
    const first = (await spin(100)).json();
    await topUp(first.state.playerId);
    for (let i = 0; i < 24; i++) await spin(100);

    const page1 = (await history('?limit=10')).json();
    expect(page1.history).toHaveLength(10);
    expect(page1.nextCursor).toBe(page1.history[9].spinId);

    const page2 = (await history(`?before=${page1.nextCursor}&limit=10`)).json();
    expect(page2.history).toHaveLength(10);
    // 全部严格早于 page1 的游标
    for (const r of page2.history) expect(r.spinId).toBeLessThan(page1.nextCursor);
    // 无重叠
    const overlap = page1.history.filter((a: any) =>
      page2.history.some((b: any) => b.spinId === a.spinId));
    expect(overlap).toHaveLength(0);
  });

  it('最后一页（不足 limit）→ nextCursor 为 null', async () => {
    for (let i = 0; i < 3; i++) await spin(100);
    const body = (await history('?limit=10')).json();
    expect(body.history).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
  });

  it('免费局：isFree=true 且 totalCost=0（不计入投入），bet 为锁定注', async () => {
    const db = app.slotsDb;
    db.prepare('UPDATE players SET free_spins_remaining = 3, free_spin_bet = 100, accumulated_multiplier = 1').run();
    for (let i = 0; i < 3; i++) await spin(100);
    const body = (await history()).json();
    const frees = body.history.filter((r: any) => r.isFree);
    expect(frees.length).toBe(3);
    for (const r of frees) {
      expect(r.mode).toBe('free');
      expect(r.totalCost).toBe(0);
      expect(r.bet).toBe(100);
    }
  });

  it('只看自己的（别的玩家转过也不串号）', async () => {
    await spin(100);
    const otherToken = (await app.inject({ method: 'POST', url: '/api/session', payload: {} })).json().token;
    await app.inject({
      method: 'POST', url: '/api/spin',
      headers: { authorization: `Bearer ${otherToken}` }, payload: { bet: 100, anteEnabled: false },
    });
    const mine = (await history()).json().history;
    expect(mine).toHaveLength(1);
    // 我的记录 player_id 全是我
    const db = app.slotsDb;
    const meId = (await app.inject({ method: 'GET', url: '/api/me', headers: auth() })).json().state.playerId;
    for (const r of mine) {
      const owner = (db.prepare('SELECT player_id FROM spins WHERE id = ?').get(r.spinId) as any).player_id;
      expect(owner).toBe(meId);
    }
  });
});
