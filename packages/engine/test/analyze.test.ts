import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze';
import { defaultPreset } from '../src/config';
import type { GameConfig } from '../src/types';

// 低方差分析器（ENG-6b）：直测 RTP 噪声 ±3~4%，无法调参；
// 这里用较小样本做结构性断言，精确调参见 docs/reports/eng6b-ante-math.md
const SMALL = { baseSpins: 60_000, featureRuns: 8_000, seedPrefix: 'test' };

describe('analyze（方差缩减分析器）', () => {
  it('RTP = 基础局 + 免费旋转 + 保底，三段合成', () => {
    const r = analyze(defaultPreset(), SMALL);
    expect(r.rtp).toBeCloseTo(r.baseGameRtp + r.featureRtp + r.pityRtp, 10);
  });

  it('同参数两次运行结果一致（确定性）', () => {
    const a = analyze(defaultPreset(), SMALL);
    const b = analyze(defaultPreset(), SMALL);
    expect(a.rtp).toBe(b.rtp);
  });

  it('误差随样本量按 √n 收敛（触发率与单段价值两项各占一半，须同时放大）', () => {
    const few = analyze(defaultPreset(), { baseSpins: 40_000, featureRuns: 5_000, seedPrefix: 'test' });
    const many = analyze(defaultPreset(), { baseSpins: 160_000, featureRuns: 20_000, seedPrefix: 'test' });
    // 两项样本各 ×4 → 合成误差应接近 ÷2
    expect(many.rtpStderr).toBeLessThan(few.rtpStderr / 1.8);
  });

  it('ante 模式：成本倍数 = 1.25，触发率显著高于基础档', () => {
    const base = analyze(defaultPreset(), SMALL);
    const ante = analyze(defaultPreset(), { ...SMALL, anteEnabled: true });
    expect(ante.costMultiplier).toBeCloseTo(1.25, 2);
    expect(base.costMultiplier).toBeCloseTo(1.0, 2);
    // 1/155 → 1/93，应快 1.5 倍以上
    expect(ante.fsTriggerRate).toBeGreaterThan(base.fsTriggerRate * 1.4);
  });

  it('【红线】Ante 档 RTP 不低于基础档——加注不能反而更亏', () => {
    const base = analyze(defaultPreset(), SMALL);
    const ante = analyze(defaultPreset(), { ...SMALL, anteEnabled: true });
    // 误差合成后允许小幅下探，但方向必须为正
    const margin = Math.hypot(base.rtpStderr, ante.rtpStderr);
    expect(ante.rtp).toBeGreaterThan(base.rtp - margin);
    expect(ante.rtp).toBeGreaterThan(0.9);
  });

  it('anteScatterFactor 过低会击穿红线（证明该参数敏感且测试有效）', () => {
    const bad: GameConfig = { ...defaultPreset(), anteScatterFactor: 1.05 };
    const base = analyze(defaultPreset(), SMALL);
    const ante = analyze(bad, { ...SMALL, anteEnabled: true });
    expect(ante.rtp).toBeLessThan(base.rtp - 0.05); // 明显更亏
  });
});
