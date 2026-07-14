import { describe, it, expect } from 'vitest';
import { simulate } from '../src/simulate';
import { defaultPreset } from '../src/config';
import type { GameConfig } from '../src/types';

describe('simulate（蒙特卡洛）', () => {
  it('同参数两次运行结果一致（确定性）', () => {
    const a = simulate(defaultPreset(), { spins: 2000, seedPrefix: 'det' });
    const b = simulate(defaultPreset(), { spins: 2000, seedPrefix: 'det' });
    expect(a.totalWin).toBe(b.totalWin);
    expect(a.totalCost).toBe(b.totalCost);
    expect(a.hits).toBe(b.hits);
  });

  it('统计字段完整且量纲合理', () => {
    const s = simulate(defaultPreset(), { spins: 5000, seedPrefix: 'sanity' });
    expect(s.spins).toBe(5000);
    expect(s.totalCost).toBe(5000 * 100); // 默认 bet=100
    expect(s.rtp).toBeGreaterThan(0.2);
    expect(s.rtp).toBeLessThan(2.0);
    expect(s.hitRate).toBeGreaterThan(0.05);
    expect(s.hitRate).toBeLessThan(0.8);
    expect(s.maxWinX).toBeLessThanOrEqual(defaultPreset().maxWinX);
  });

  it('免费旋转被真实打完：scatter 加重后 fsTriggers>0 且 featureWin>0', () => {
    const cfg: GameConfig = { ...defaultPreset(), scatterWeight: 12 };
    const s = simulate(cfg, { spins: 600, seedPrefix: 'fs' });
    expect(s.fsTriggers).toBeGreaterThan(0);
    expect(s.featureWin).toBeGreaterThan(0);
  });

  it('保底：骰子进度攒满 100 触发 10 次免费旋转', () => {
    const cfg: GameConfig = { ...defaultPreset(), scatterWeight: 12 };
    const withPity = simulate(cfg, { spins: 600, seedPrefix: 'pity', includePity: true });
    const noPity = simulate(cfg, { spins: 600, seedPrefix: 'pity', includePity: false });
    expect(withPity.pityTriggers).toBeGreaterThan(0);
    expect(noPity.pityTriggers).toBe(0);
    expect(withPity.totalWin).toBeGreaterThanOrEqual(noPity.totalWin);
  });

  it('ante 模式：totalCost = spins × bet × 1.25', () => {
    const s = simulate(defaultPreset(), { spins: 1000, anteEnabled: true, seedPrefix: 'ante' });
    expect(s.totalCost).toBe(Math.round(1000 * 100 * 1.25));
  });
});
