import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze';
import { defaultPreset, getPreset, PRESET_IDS } from '../src/config';

/**
 * ENG-10 验收：四档预设的标定 RTP 必须与实测相符（±0.5 个百分点）。
 *
 * 这里用中等样本（stderr ≈ 0.4pp）做回归守卫，容差取 1.0pp ≈ 2.5σ：
 * 目的是拦住"改了权重却没重新标定"这类回归，而不是复现精调过程。
 * 精调的高精度验证见 docs/reports/eng10-preset-rtp.md（stderr ≈ 0.1pp）。
 */
const TARGETS: Record<string, number> = {
  rtp92: 0.92,
  rtp945: 0.945,
  rtp965: 0.965,
  rtp975: 0.975,
};

describe('四档预设 RTP 标定（ENG-10）', () => {
  it('每档都带 nominalRtp，且落在目标档位 ±0.5pp 内', () => {
    // 公示的是**实测标定值**（92.2/94.7/96.3/97.1），不是漂亮的目标数字——
    // 玩家看到的必须是真值，标定误差如实体现在这 0.5pp 的容差里。
    for (const id of PRESET_IDS) {
      const cfg = getPreset(id);
      expect(Math.abs(cfg.nominalRtp - TARGETS[id]!), `${id}: nominalRtp=${cfg.nominalRtp}`).toBeLessThan(0.005);
    }
  });

  it('默认档就是 rtp965（否则服务端初始配置会自称 96.5 档却不是它）', () => {
    const d = defaultPreset();
    const p = getPreset('rtp965');
    expect(d.payoutScale).toBeCloseTo(p.payoutScale, 6);
    expect(d.nominalRtp).toBeCloseTo(p.nominalRtp, 6);
  });

  it.each(PRESET_IDS)('%s 的实测 RTP 与标定值相符', (id) => {
    const cfg = getPreset(id);
    const r = analyze(cfg, { baseSpins: 200_000, featureRuns: 300_000, seedPrefix: `preset-${id}` });
    const errPp = Math.abs(r.rtp - cfg.nominalRtp) * 100;
    expect(errPp, `${id}: 标定 ${(cfg.nominalRtp * 100).toFixed(2)}% vs 实测 ${(r.rtp * 100).toFixed(2)}% ± ${(r.rtpStderr * 100).toFixed(2)}pp`)
      .toBeLessThan(1.0);
  }, 120_000);

  it('档位单调：92 < 94.5 < 96.5 < 97.5', () => {
    const scales = PRESET_IDS.map((id) => getPreset(id).payoutScale);
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeGreaterThan(scales[i - 1]!);
  });
});
