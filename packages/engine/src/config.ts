import type { GameConfig } from './types';

export const PRESET_IDS = ['rtp92', 'rtp945', 'rtp965', 'rtp975'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/**
 * 四档 RTP 预设：同一套权重/赔付，payoutScale 为总旋钮。
 *
 * ENG-10 重校（2026-07-14）：scale 与 nominalRtp 均由 `analyze()` 实测标定，
 * 样本 250 万基础局 + 250 万免费旋转段，估计噪声 ±0.15pp，各档偏离目标 ≤0.40pp。
 * 相对默认档（= rtp965）缩放。**改了任何权重/赔付，这些标定值就失效**，
 * 必须重跑 `npx tsx packages/engine/src/recalibrate.ts`；玩家侧公示的 RTP 就是 nominalRtp。
 */
export function getPreset(id: string): GameConfig {
  // buyMult：Bonus Buy 买入价倍数，每档单独标定（ENG-8），随 payoutScale 变。
  //   买入价 = buyMult × 注；按「买入档 RTP ≈ 该档公示 RTP」定：buyMult = E[10 次段价值×注] / rtp。
  //   由 `npx tsx packages/engine/src/bonusbuy-calibrate.ts` 产出，改权重/赔付/scale 后须重跑。
  // buyMult 由 500k 段标定，复测买入档 RTP 与公示 RTP 偏差 ≤0.66pp（噪声 ±0.5pp），详见 eng8 报告。
  const presets: Record<PresetId, { scale: number; rtp: number; buyMult: number }> = {
    rtp92: { scale: 0.9561, rtp: 0.922, buyMult: 44.21 },   // 买入档复测 92.08% ± 0.48pp
    rtp945: { scale: 0.9793, rtp: 0.947, buyMult: 44.86 },  // 买入档复测 94.27% ± 0.50pp
    rtp965: { scale: 1.0, rtp: 0.963, buyMult: 44.30 },     // 买入档复测 96.21% ± 0.51pp（默认档）
    rtp975: { scale: 1.0142, rtp: 0.971, buyMult: 44.51 },  // 买入档复测 97.76% ± 0.52pp
  };
  const p = presets[id as PresetId];
  if (p === undefined) throw new Error(`未知预设: ${id}（可用: ${PRESET_IDS.join(', ')}）`);
  const cfg = defaultPreset();
  cfg.presetId = id;
  cfg.payoutScale = cfg.payoutScale * p.scale;
  cfg.nominalRtp = p.rtp;
  cfg.bonusBuy = { enabled: true, costMultiplier: p.buyMult };
  return cfg;
}

// 默认档（目标 RTP 96.5%）。数值由模拟器调参（ENG-1），payoutScale 是总旋钮。
export function defaultPreset(): GameConfig {
  return {
    presetId: 'rtp965',
    columns: 6,
    rows: 5,
    symbols: {
      zhong: { weight: 15, pay: [8, 20, 80] },
      fa: { weight: 18, pay: [4, 10, 40] },
      east: { weight: 25, pay: [1.5, 4, 15] },
      south: { weight: 25, pay: [1.5, 4, 15] },
      west: { weight: 25, pay: [1.5, 4, 15] },
      north: { weight: 25, pay: [1.5, 4, 15] },
      wan: { weight: 31, pay: [0.5, 1.5, 6] },
      tong: { weight: 31, pay: [0.5, 1.5, 6] },
      tiao: { weight: 31, pay: [0.5, 1.5, 6] },
    },
    wildWeight: 6,
    scatterWeight: 6,
    goldWeight: 3,
    goldValues: [
      { multiplier: 2, weight: 70 },
      { multiplier: 5, weight: 24 },
      { multiplier: 20, weight: 5 },
      { multiplier: 100, weight: 1 },
    ],
    chainLadder: [1, 2, 3, 5, 10],
    ladderStepAfter: 5,
    freeSpins: { trigger: 4, base: 10, perExtra: 2 },
    anteCostMultiplier: 1.25,
    // ENG-6b：注 ×1.25 换免费旋转触发率 1/153 → 1/93（快 1.64 倍）。
    // ENG-10 勘误：ENG-6b 曾称"RTP 还高 0.9%"，那是分析器偏差造出来的假象——
    // 修正后 Ante 档 RTP 与基础档基本持平（差值在噪声内）。加注买的是"更快"，不是"更赚"。
    // 触发概率 ∝ 权重⁴，此值极敏感，改动必须跑 analyze.ts 复测。
    anteScatterFactor: 1.16,
    maxWinX: 5000,
    // ENG-10 标定：0.42 × 1.0056（96.5 档）。默认档就是 rtp965，二者必须一致。
    payoutScale: 0.4224,
    nominalRtp: 0.963,
    // ENG-8 Bonus Buy：默认开；买入价倍数 = rtp965 档标定值（须与 getPreset('rtp965').bonusBuy 一致）。
    bonusBuy: { enabled: true, costMultiplier: 44.30 },
  };
}
