import { describe, it, expect } from 'vitest';
import { freeSpinTriggerRate, anteSpeedup } from '../src/trigger';
import { defaultPreset } from '../src/config';
import { analyze } from '../src/analyze';
import type { GameConfig } from '../src/types';

describe('freeSpinTriggerRate（解析计算，不靠模拟）', () => {
  it('与模拟器实测吻合（基础档 ≈ 1/152）', () => {
    const analytic = freeSpinTriggerRate(defaultPreset(), false);
    const measured = analyze(defaultPreset(), { baseSpins: 200_000, featureRuns: 1, seedPrefix: 'tr' }).fsTriggerRate;
    // 解析值与 20 万次实测的相对偏差应 < 8%（实测本身有采样误差）
    expect(Math.abs(analytic - measured) / measured).toBeLessThan(0.08);
    expect(1 / analytic).toBeGreaterThan(130);
    expect(1 / analytic).toBeLessThan(175);
  });

  it('ante 档触发率显著更高（≈ 1/93）', () => {
    const ante = freeSpinTriggerRate(defaultPreset(), true);
    const measured = analyze(defaultPreset(), { baseSpins: 200_000, featureRuns: 1, anteEnabled: true, seedPrefix: 'tr' }).fsTriggerRate;
    expect(Math.abs(ante - measured) / measured).toBeLessThan(0.08);
    expect(1 / ante).toBeGreaterThan(80);
    expect(1 / ante).toBeLessThan(105);
  });

  it('是概率：落在 (0,1)', () => {
    const r = freeSpinTriggerRate(defaultPreset(), false);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  it('骰子权重越高触发越频繁（单调）', () => {
    const low: GameConfig = { ...defaultPreset(), scatterWeight: 4 };
    const high: GameConfig = { ...defaultPreset(), scatterWeight: 9 };
    expect(freeSpinTriggerRate(high, false)).toBeGreaterThan(freeSpinTriggerRate(low, false));
  });

  it('触发概率对权重高度敏感（需 4 个骰子，近似四次方效应）', () => {
    const a = freeSpinTriggerRate({ ...defaultPreset(), scatterWeight: 6 }, false);
    const b = freeSpinTriggerRate({ ...defaultPreset(), scatterWeight: 12 }, false);
    // 权重翻倍 → 触发率涨约 8.8 倍（1/152 → 1/17），当初 factor=2 就是这样击穿 RTP 的
    expect(b / a).toBeGreaterThan(8);
    expect(b / a).toBeLessThan(10);
  });
});

describe('anteSpeedup（给玩家看的"快多少倍"）', () => {
  it('默认配置下 ante 让免费旋转快 1.5~1.8 倍', () => {
    const s = anteSpeedup(defaultPreset());
    expect(s).toBeGreaterThan(1.5);
    expect(s).toBeLessThan(1.8);
  });

  it('= ante 触发率 ÷ 基础触发率', () => {
    const cfg = defaultPreset();
    expect(anteSpeedup(cfg)).toBeCloseTo(
      freeSpinTriggerRate(cfg, true) / freeSpinTriggerRate(cfg, false), 10,
    );
  });

  it('随配置变化而变（不会因后台改权重而变成谎言）', () => {
    const aggressive: GameConfig = { ...defaultPreset(), anteScatterFactor: 1.5 };
    expect(anteSpeedup(aggressive)).toBeGreaterThan(anteSpeedup(defaultPreset()));
  });
});
