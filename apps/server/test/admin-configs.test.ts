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

describe('配置管理（SRV-4）', () => {
  it('未登录访问任何配置接口 → 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/configs'],
      ['POST', '/api/admin/configs'],
      ['POST', '/api/admin/configs/1/publish'],
      ['POST', '/api/admin/simulate'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it('初始状态：version 1 已发布', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/configs', headers: auth() });
    const { configs } = res.json();
    expect(configs).toHaveLength(1);
    expect(configs[0].version).toBe(1);
    expect(configs[0].status).toBe('published');
  });

  it('从预设建草稿 → 修改 → 发布 → 新 spin 用新版本；改非草稿 → 409', async () => {
    // 建草稿（rtp92 预设）
    const create = await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth(),
      payload: { preset: 'rtp92', label: '狠一点的档' },
    });
    expect(create.statusCode).toBe(200);
    const draft = create.json().meta;
    expect(draft.version).toBe(2);
    expect(draft.status).toBe('draft');

    // 读回完整配置并修改一个权重
    const full = (await app.inject({ method: 'GET', url: `/api/admin/configs/2`, headers: auth() })).json();
    expect(full.config.presetId).toBe('rtp92');
    full.config.wildWeight = 7;
    const update = await app.inject({
      method: 'PUT', url: '/api/admin/configs/2', headers: auth(),
      payload: { config: full.config },
    });
    expect(update.statusCode).toBe(200);

    // 修改已发布的 version 1 → 409
    const bad = await app.inject({
      method: 'PUT', url: '/api/admin/configs/1', headers: auth(),
      payload: { config: full.config },
    });
    expect(bad.statusCode).toBe(409);

    // 发布 2：1 变 retired
    const pub = await app.inject({ method: 'POST', url: '/api/admin/configs/2/publish', headers: auth() });
    expect(pub.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/configs', headers: auth() })).json().configs;
    expect(list.find((c: { version: number }) => c.version === 1).status).toBe('retired');
    expect(list.find((c: { version: number }) => c.version === 2).status).toBe('published');

    // 新 spin 关联 version 2
    const session = (await app.inject({ method: 'POST', url: '/api/session', payload: {} })).json();
    await app.inject({
      method: 'POST', url: '/api/spin',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { bet: 10, anteEnabled: false },
    });
    const row = app.slotsDb.prepare('SELECT config_version FROM spins ORDER BY id DESC LIMIT 1').get() as { config_version: number };
    expect(row.config_version).toBe(2);
  });

  it('回滚：以历史版本复制出新版本并直接发布', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth(),
      payload: { preset: 'rtp975', label: '松档' },
    });
    await app.inject({ method: 'POST', url: `/api/admin/configs/${create.json().meta.version}/publish`, headers: auth() });

    // 回滚到 version 1
    const rb = await app.inject({ method: 'POST', url: '/api/admin/configs/1/rollback', headers: auth() });
    expect(rb.statusCode).toBe(200);
    const meta = rb.json().meta;
    expect(meta.version).toBe(3);
    expect(meta.status).toBe('published');
    const v3 = (await app.inject({ method: 'GET', url: '/api/admin/configs/3', headers: auth() })).json();
    const v1 = (await app.inject({ method: 'GET', url: '/api/admin/configs/1', headers: auth() })).json();
    expect(v3.config).toEqual(v1.config);
  });

  it('模拟估算：返回 rtp/hitRate，并把结果写回草稿的 estimatedRtp', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth(),
      payload: { preset: 'rtp965', label: '估算测试' },
    });
    const v = create.json().meta.version;
    const sim = await app.inject({
      method: 'POST', url: '/api/admin/simulate', headers: auth(),
      payload: { version: v, spins: 20000 },
    });
    expect(sim.statusCode).toBe(200);
    const body = sim.json();
    expect(body.rtp).toBeGreaterThan(0.5);
    expect(body.rtp).toBeLessThan(1.5);
    expect(body.hitRate).toBeGreaterThan(0.1);
    const meta = (await app.inject({ method: 'GET', url: `/api/admin/configs/${v}`, headers: auth() })).json().meta;
    expect(meta.estimatedRtp).toBeCloseTo(body.rtp, 5);
  });

  it('无参 POST 带 content-type:application/json 且 body 为空时不报 400（浏览器 fetch 的真实发法）', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth(),
      payload: { preset: 'rtp965', label: '空 body 发布测试' },
    });
    const v = create.json().meta.version;
    const res = await app.inject({
      method: 'POST', url: `/api/admin/configs/${v}/publish`,
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.status).toBe('published');
  });

  it('模拟估算超出上限 spins → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/simulate', headers: auth(),
      payload: { version: 1, spins: 10_000_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});
