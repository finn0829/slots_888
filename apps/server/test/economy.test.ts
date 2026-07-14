import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
let token: string;
let playerId: number;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
  const res = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
  token = res.json().token;
  playerId = res.json().state.playerId;
});

const auth = () => ({ authorization: `Bearer ${token}` });
const setBalance = (v: number) => app.slotsDb.prepare('UPDATE players SET balance = ? WHERE id = ?').run(v, playerId);
const balance = () => (app.slotsDb.prepare('SELECT balance FROM players WHERE id = ?').get(playerId) as { balance: number }).balance;
const txTypes = () => app.slotsDb.prepare('SELECT type FROM transactions WHERE player_id = ?').all(playerId).map((r) => (r as { type: string }).type);

describe('每日签到（SRV-7）', () => {
  it('首次签到得 1000 文，余额与流水都对', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe(1000);
    expect(res.json().state.balance).toBe(11000);
    expect(balance()).toBe(11000);
    expect(txTypes()).toContain('daily_bonus');
  });

  it('同一 UTC 日重复签到 → 409，余额不变', async () => {
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    const again = await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    expect(again.statusCode).toBe(409);
    expect(balance()).toBe(11000);
  });

  it('跨日后可再签', async () => {
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    app.slotsDb.prepare("UPDATE players SET last_daily_claim_at = datetime('now','-2 days') WHERE id = ?").run(playerId);
    const res = await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(balance()).toBe(12000);
  });

  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/claim-daily' });
    expect(res.statusCode).toBe(401);
  });
});

describe('破产补币（SRV-7）', () => {
  it('余额低于最低注（10）时可领 2000 文', async () => {
    setBalance(5);
    const res = await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe(2000);
    expect(balance()).toBe(2005);
    expect(txTypes()).toContain('bankrupt_relief');
  });

  it('余额够玩（≥10）时不给领 → 409', async () => {
    setBalance(500);
    const res = await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(balance()).toBe(500);
  });

  it('4 小时冷却内不可重复领 → 409', async () => {
    setBalance(0);
    await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    setBalance(0);
    const again = await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    expect(again.statusCode).toBe(409);
    expect(balance()).toBe(0);
  });

  it('冷却过后可再领', async () => {
    setBalance(0);
    await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    app.slotsDb.prepare("UPDATE players SET last_relief_at = datetime('now','-5 hours') WHERE id = ?").run(playerId);
    setBalance(0);
    const res = await app.inject({ method: 'POST', url: '/api/claim-relief', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(balance()).toBe(2000);
  });
});

describe('/api/me 暴露领取资格（前端据此显示按钮）', () => {
  it('新玩家：可签到、不可领救济（余额充足）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: auth() });
    const s = res.json().state;
    expect(s.canClaimDaily).toBe(true);
    expect(s.canClaimRelief).toBe(false);
  });

  it('签到后 canClaimDaily 变 false；破产后 canClaimRelief 变 true', async () => {
    await app.inject({ method: 'POST', url: '/api/claim-daily', headers: auth() });
    setBalance(0);
    const s = (await app.inject({ method: 'GET', url: '/api/me', headers: auth() })).json().state;
    expect(s.canClaimDaily).toBe(false);
    expect(s.canClaimRelief).toBe(true);
  });
});
