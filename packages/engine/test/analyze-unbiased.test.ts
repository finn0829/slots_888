import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze';
import { simulate } from '../src/simulate';
import { defaultPreset } from '../src/config';
import { spin } from '../src/spin';
import type { GameConfig } from '../src/types';

/**
 * 偏差守卫（ENG-10）。
 *
 * 血泪教训：ENG-6b 的分析器把保底通道写成 pityValue = E[单段价值] × (10 / avgAward)，
 * 即假设"一段免费旋转的价值随次数线性缩放"。它不是线性的——累计倍数在整段里滚雪球，
 * 段越长越值钱 ⇒ 按比例折算把保底（占 RTP 三成）系统性高估，基准档被报成 97.4%，
 * 真值 95.7%。一个 ±0.1pp 的漂亮误差条，套在偏了 1.7pp 的估计上，比没有误差条更危险。
 *
 * 关键认识：**直接模拟救不了这个 bug**——3M 局直测的标准误差就有 ±1.1pp，
 * 分辨不出 1.7pp 的偏差（下面第二个测试如实展示了这一点）。
 * 所以守卫必须直接打在那个错误假设上：证伪"线性"。
 */

/** 打一整段免费旋转，返回总赢（×注） */
function featureValue(config: GameConfig, seedBase: string, spins: number): number {
  const bet = 100;
  let remaining = spins;
  let acc = 1;
  let win = 0;
  let i = 0;
  while (remaining > 0 && i < 5000) {
    const r = spin({ seed: `${seedBase}:f${i}`, bet, anteEnabled: false, mode: 'free', accumulatedMultiplier: acc, config });
    win += r.totalWin;
    acc = r.accumulatedMultiplierAfter;
    remaining += r.freeSpinsAwarded - 1;
    i++;
  }
  return win / bet;
}

const meanValue = (cfg: GameConfig, spins: number, runs: number, tag: string) => {
  let sum = 0;
  for (let i = 0; i < runs; i++) sum += featureValue(cfg, `${tag}:${i}`, spins);
  return sum / runs;
};

describe('分析器无偏性（ENG-10）', () => {
  it('免费旋转的价值不随次数线性缩放——累计倍数滚雪球，段越长越值钱', () => {
    const cfg = defaultPreset();
    const v10 = meanValue(cfg, 10, 40_000, 'v10');
    const v20 = meanValue(cfg, 20, 40_000, 'v20');

    // 若线性，v20 应 = 2 × v10。实际显著更高 ⇒ 按比例折算保底价值必然高估。
    expect(v20, `v10=${v10.toFixed(1)}x, v20=${v20.toFixed(1)}x, 比值 ${(v20 / v10).toFixed(2)}（线性应为 2.00）`)
      .toBeGreaterThan(2.1 * v10);
  }, 300_000);

  it('保底通道按 10 次的段直接模拟，不做任何线性外推', () => {
    const cfg = defaultPreset();
    const a = analyze(cfg, { baseSpins: 50_000, featureRuns: 20_000, seedPrefix: 'pity' });
    const withoutPity = analyze(cfg, { baseSpins: 50_000, featureRuns: 20_000, seedPrefix: 'pity', includePity: false });

    // 保底贡献 = 骰子率/100 × E[10 次段的价值] / 成本倍数（解析 × 直接模拟，无折算）
    const scatterRate = a.scatterPerSpin / 100;
    const v10 = meanValue(cfg, 10, 20_000, 'pity:P');
    const expected = (scatterRate * v10) / a.costMultiplier;

    expect(a.pityRtp).toBeGreaterThan(0);
    expect(Math.abs(a.rtp - withoutPity.rtp - a.pityRtp)).toBeLessThan(1e-9);
    // 与手算的保底贡献同量级（seed 不同，容 15% 相对差）
    expect(Math.abs(a.pityRtp - expected) / expected).toBeLessThan(0.15);
  }, 300_000);

  it('与直接模拟不矛盾——但如实记录：直测精度不足以证伪 1.7pp 的偏差', () => {
    const cfg = defaultPreset();
    const a = analyze(cfg, { baseSpins: 300_000, featureRuns: 400_000, seedPrefix: 'unb-a' });
    const s = simulate(cfg, { spins: 3_000_000, seedPrefix: 'unb-s' });

    const directStderr = s.stdevX / Math.sqrt(3_000_000);
    const sigma = Math.sqrt(a.rtpStderr ** 2 + directStderr ** 2);
    const gap = Math.abs(a.rtp - s.rtp);

    // 这道闸只拦得住"粗大偏差"（>3σ ≈ 3pp）。真正拦住线性假设的是上面那个测试。
    expect(
      gap,
      `analyze ${(a.rtp * 100).toFixed(2)}% ± ${(a.rtpStderr * 100).toFixed(2)}pp`
      + ` vs simulate ${(s.rtp * 100).toFixed(2)}% ± ${(directStderr * 100).toFixed(2)}pp（直测噪声之大，正是它救不了场的原因）`,
    ).toBeLessThan(3 * sigma);
  }, 600_000);
});
