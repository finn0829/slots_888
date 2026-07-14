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
const spin = () => app.inject({ method: 'POST', url: '/api/spin', headers: auth(), payload: { bet: 100, anteEnabled: false } });
const lastSpin = () => app.inject({ method: 'GET', url: '/api/last-spin', headers: auth() });

describe('GET /api/last-spin（WEB-18 断线重连）', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/last-spin' });
    expect(res.statusCode).toBe(401);
  });

  it('从未转过 → spin 为 null（新玩家不该看到别人的盘面）', async () => {
    const res = await lastSpin();
    expect(res.statusCode).toBe(200);
    expect(res.json().spin).toBeNull();
  });

  it('返回最后一局的完整 SpinResult，且与该局 /api/spin 的返回一致', async () => {
    await spin();
    const second = (await spin()).json().spin;
    const last = (await lastSpin()).json().spin;
    expect(last).toEqual(second);
  });

  it('最后一次 cascade 的 gridAfter 是可直接上盘的 6×5 终盘', async () => {
    await spin();
    const last = (await lastSpin()).json().spin;
    const grid = last.cascades.at(-1).gridAfter;
    expect(grid).toHaveLength(6);
    for (const col of grid) {
      expect(col).toHaveLength(5);
      for (const cell of col) expect(typeof cell.symbol).toBe('string'); // Grid = Cell[][]，不是字符串矩阵
    }
  });

  it('免费旋转中途查询，拿到的是最后那一局免费旋转', async () => {
    // 刷到免费旋转
    let free = false;
    for (let i = 0; i < 3000 && !free; i++) {
      const r = (await spin()).json();
      if (r.state.balance < 100) {
        // 测试里不走救济金冷却，直接再开一局会 402——用管理接口补币
        const adminToken = (await app.inject({
          method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' },
        })).json().adminToken;
        await app.inject({
          method: 'POST', url: `/api/admin/players/${r.state.playerId}/credit`,
          headers: { authorization: `Bearer ${adminToken}` }, payload: { amount: 100000 },
        });
      }
      free = r.state.freeSpinsRemaining > 0;
    }
    expect(free).toBe(true);
    const during = (await spin()).json(); // 打掉一局免费旋转
    expect(during.spin.mode).toBe('free');
    const last = (await lastSpin()).json().spin;
    expect(last.mode).toBe('free');
    expect(last).toEqual(during.spin);
  });

  it('只能拿到自己的最后一局（别的玩家转过也不串号）', async () => {
    await spin();
    const mine = (await lastSpin()).json().spin;
    const other = (await app.inject({ method: 'POST', url: '/api/session', payload: {} })).json().token;
    const otherLast = (await app.inject({
      method: 'GET', url: '/api/last-spin', headers: { authorization: `Bearer ${other}` },
    })).json();
    expect(otherLast.spin).toBeNull();
    expect((await lastSpin()).json().spin).toEqual(mine);
  });
});
