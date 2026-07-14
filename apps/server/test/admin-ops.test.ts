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

describe('管理操作日志（SRV-9）', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/ops' });
    expect(res.statusCode).toBe(401);
  });

  it('登录、发布、回滚动作自动进日志，含 detail', async () => {
    await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth(),
      payload: { preset: 'rtp92', label: '狠档' },
    });
    await app.inject({ method: 'POST', url: '/api/admin/configs/2/publish', headers: auth() });
    await app.inject({ method: 'POST', url: '/api/admin/configs/1/rollback', headers: auth() });

    const res = await app.inject({ method: 'GET', url: '/api/admin/ops', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { ops, total } = res.json();
    expect(total).toBeGreaterThanOrEqual(3);
    const actions = ops.map((o: { action: string }) => o.action);
    expect(actions).toEqual(expect.arrayContaining(['login', 'config_publish', 'config_rollback']));

    const publish = ops.find((o: { action: string }) => o.action === 'config_publish');
    expect(JSON.parse(publish.detail).version).toBe(2);
    // 倒序：最新在前
    expect(actions.indexOf('config_rollback')).toBeLessThan(actions.indexOf('login'));
  });

  it('按 type 过滤 + 分页 total 正确', async () => {
    // 再登录两次 → login 至少 3 条
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' } });
    }
    const res = await app.inject({ method: 'GET', url: '/api/admin/ops?type=login', headers: auth() });
    const { ops, total } = res.json();
    expect(total).toBe(3);
    expect(ops.every((o: { action: string }) => o.action === 'login')).toBe(true);
  });

  it('失败的登录不进日志', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'wrong' } });
    const res = await app.inject({ method: 'GET', url: '/api/admin/ops?type=login', headers: auth() });
    expect(res.json().total).toBe(1);
  });
});
