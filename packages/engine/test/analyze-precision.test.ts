import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze';
import { freeSpinTriggerRate } from '../src/trigger';
import { defaultPreset } from '../src/config';
import type { GameConfig } from '../src/types';

const withScale = (scale: number): GameConfig => {
  const cfg = defaultPreset();
  cfg.payoutScale = defaultPreset().payoutScale * scale;
  return cfg;
};

describe('分析器精度（ENG-10 重校前提）', () => {
  it('触发率用解析值，不再采样——这份噪声可以完全消掉', () => {
    const cfg = defaultPreset();
    const r = analyze(cfg, { baseSpins: 20_000, featureRuns: 2_000, seedPrefix: 'p1' });
    // 二项分布精确解，与样本量无关
    expect(r.fsTriggerRate).toBe(freeSpinTriggerRate(cfg, false));
  });

  it('ante 档的触发率同样走解析值', () => {
    const cfg = defaultPreset();
    const r = analyze(cfg, { baseSpins: 20_000, featureRuns: 2_000, anteEnabled: true, seedPrefix: 'p2' });
    expect(r.fsTriggerRate).toBe(freeSpinTriggerRate(cfg, true));
  });

  it('RTP 与 payoutScale 近似成正比——这是"用 scale 标定档位"的理论前提，必须实测而非假设', () => {
    // 同一组 seed（配对比较），噪声大部分抵消，剩下的偏离才是封顶带来的非线性
    const opts = { baseSpins: 60_000, featureRuns: 12_000, seedPrefix: 'lin' };
    const a = analyze(withScale(1), opts);
    const b = analyze(withScale(0.5), opts);
    const ratio = b.rtp / a.rtp;
    // 完全线性应为 0.5；5000× 封顶会让高 scale 略微吃亏，故 ratio 略 ≥ 0.5
    expect(ratio).toBeGreaterThan(0.49);
    expect(ratio).toBeLessThan(0.53);
  }, 120_000);

  it('误差随免费旋转样本量 ×4 而减半（触发率噪声消掉后，它是唯一的噪声源）', () => {
    const cfg = defaultPreset();
    const small = analyze(cfg, { baseSpins: 100_000, featureRuns: 10_000, seedPrefix: 'e1' });
    const big = analyze(cfg, { baseSpins: 100_000, featureRuns: 40_000, seedPrefix: 'e1' });
    const shrink = small.rtpStderr / big.rtpStderr;
    expect(shrink).toBeGreaterThan(1.6);
    expect(shrink).toBeLessThan(2.5);
  }, 120_000);

  // 注：analyze() 给定 seedPrefix 是确定性的（sfc32，无 Math.random/Date 参与判定），
  // 本测试的断言不会随机翻红。此前观察到的偶发失败其实是**测试超时**——这几个重蒙特卡洛
  // 测试各跑 ~5s，贴着 vitest 默认 5000ms 超时线，负载下偶尔越线判失败。补足超时即根治，
  // 与统计有效性无关（兄弟文件 analyze-unbiased/bonusbuy-rtp 早已用 120k~600k 的超时）。
  it('两次独立估计之差落在 3σ 内（估计器自洽，误差没被低估）', () => {
    // 用 3σ 而非 2σ：不同 seed 的两次估计本就有差异，3σ 给统计留足余量。
    const cfg = defaultPreset();
    const opts = { baseSpins: 150_000, featureRuns: 30_000 };
    const a = analyze(cfg, { ...opts, seedPrefix: 'c1' });
    const b = analyze(cfg, { ...opts, seedPrefix: 'c2' });
    const sigma = Math.sqrt(a.rtpStderr ** 2 + b.rtpStderr ** 2);
    expect(
      Math.abs(a.rtp - b.rtp),
      `c1=${(a.rtp * 100).toFixed(2)}% c2=${(b.rtp * 100).toFixed(2)}%，σ=${(sigma * 100).toFixed(2)}pp`,
    ).toBeLessThan(3 * sigma);
  }, 120_000);
});
