import { describe, it, expect } from 'vitest';
import { featureSegmentValueX } from '../src/analyze';
import { defaultPreset, getPreset, PRESET_IDS } from '../src/config';

/**
 * ENG-8 红线：Bonus Buy 是「花钱买 10 次免费旋转」，买入档 RTP 必须 ≈ 该档公示 RTP，
 * 且**不显著低于**它——否则就是把玩家的钱按更差的返奖率兑走，属概率诚实原则红线。
 *
 *   买入档 RTP = E[10 次段价值×注] / costMultiplier
 *
 * E[段价值] 用 engine 唯一真相源 featureSegmentValueX 直接模拟（含再触发/累计倍数滚雪球，
 * 无线性外推）。中等样本 stderr ≈ 0.65pp，容差 1.5pp ≈ 2.3σ：拦"改了权重/scale 却没重标买入价"
 * 这类回归，而不是复现精调（高精度标定见 docs/reports/eng8-bonus-buy-rtp.md）。
 */
describe('Bonus Buy 买入价标定（ENG-8）', () => {
  it('默认档的买入价倍数 = rtp965（否则服务端初始配置的买入价与它自称的档位不符）', () => {
    expect(defaultPreset().bonusBuy.costMultiplier).toBeCloseTo(getPreset('rtp965').bonusBuy.costMultiplier, 6);
  });

  it('四档默认都开启 Bonus Buy', () => {
    for (const id of PRESET_IDS) expect(getPreset(id).bonusBuy.enabled).toBe(true);
    expect(defaultPreset().bonusBuy.enabled).toBe(true);
  });

  it.each(PRESET_IDS)('%s 的买入档 RTP ≈ 公示 RTP 且不显著低于它（红线）', (id) => {
    const cfg = getPreset(id);
    const v = featureSegmentValueX(cfg, { award: 10, runs: 300_000, seedPrefix: `bb-${id}` });
    const buyRtp = v.valueX / cfg.bonusBuy.costMultiplier;
    const msg = `${id}: 买入档 ${(buyRtp * 100).toFixed(2)}% vs 公示 ${(cfg.nominalRtp * 100).toFixed(2)}% ± ${(v.stderr / cfg.bonusBuy.costMultiplier * 100).toFixed(2)}pp`;
    // ① 与公示档持平（双向容差）
    expect(Math.abs(buyRtp - cfg.nominalRtp), msg).toBeLessThan(0.015);
    // ② 红线：买入不是更差的返奖率——买入档 RTP 不显著低于公示档
    expect(buyRtp, msg).toBeGreaterThan(cfg.nominalRtp - 0.015);
  }, 120_000);

  it('买入价随档位单调（E[段价值] 随 payoutScale 增）', () => {
    const mults = PRESET_IDS.map((id) => getPreset(id).bonusBuy.costMultiplier);
    // 不强求严格单调（标定噪声 ±0.5pp 会让相邻档接近），但整体应随档位上升
    expect(mults[mults.length - 1]!).toBeGreaterThan(mults[0]!);
  });
});
