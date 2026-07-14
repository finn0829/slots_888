import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { defaultPreset } from '@slots/engine';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ':memory:', adminPassword: 'test-admin' });
});

const config = async () => (await app.inject({ method: 'GET', url: '/api/config' })).json();
const adminToken = async () => (await app.inject({
  method: 'POST', url: '/api/admin/login', payload: { password: 'test-admin' },
})).json().adminToken;

/**
 * 公示 RTP（ENG-10）：规则页给玩家看的返奖率必须来自服务端的当前配置，
 * 不能在前端写死——后台改了权重，写死的数字就成了对玩家的谎言（概率诚实原则红线）。
 */
describe('公示 RTP 随配置下发（ENG-10）', () => {
  it('/api/config 下发 rtp，等于生效配置的标定值', async () => {
    const cfg = await config();
    expect(typeof cfg.rtp).toBe('number');
    expect(cfg.rtp).toBeCloseTo(defaultPreset().nominalRtp, 4);
  });

  it('切换到 92 档后，公示的 rtp 跟着变（不是写死的 96.5）', async () => {
    const token = await adminToken();
    const auth = { authorization: `Bearer ${token}` };
    const before = (await config()).rtp;

    const draft = (await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth,
      payload: { preset: 'rtp92', label: '低档测试' },
    })).json().meta;
    await app.inject({ method: 'POST', url: `/api/admin/configs/${draft.version}/publish`, headers: auth });

    const after = (await config()).rtp;
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(0.92, 2);
  });

  it('管理员跑过模拟器的草稿：公示值用模拟器估算值（改过权重后标定值已失效）', async () => {
    const token = await adminToken();
    const auth = { authorization: `Bearer ${token}` };

    const draft = (await app.inject({
      method: 'POST', url: '/api/admin/configs', headers: auth,
      payload: { preset: 'rtp965', label: '改权重' },
    })).json().meta;

    // 改权重 + 跑估算（服务端会把 estimated_rtp 存进版本）
    const full = (await app.inject({ method: 'GET', url: `/api/admin/configs/${draft.version}`, headers: auth })).json();
    const cfg = full.config;
    cfg.symbols.zhong.weight = 30; // 顶符号权重翻倍 → RTP 会变
    await app.inject({
      method: 'PUT', url: `/api/admin/configs/${draft.version}`, headers: auth,
      payload: { config: cfg },
    });
    const sim = (await app.inject({
      method: 'POST', url: '/api/admin/simulate', headers: auth,
      payload: { config: cfg, spins: 20_000, version: draft.version }, // 带 version 才会把估算值存进该版本
    })).json();
    await app.inject({ method: 'POST', url: `/api/admin/configs/${draft.version}/publish`, headers: auth });

    const pub = await config();
    // 公示值应跟随该版本的估算值，而不是预设的标定值
    expect(pub.rtp).toBeCloseTo(sim.rtp, 4);
  }, 60_000);
});
