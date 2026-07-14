import type { GameConfig } from './types';

export const PRESET_IDS = ['rtp92', 'rtp945', 'rtp965', 'rtp975'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** 四档 RTP 预设：同一套权重/赔付，payoutScale 为总旋钮（各档均需模拟器验证） */
export function getPreset(id: string): GameConfig {
  const scales: Record<PresetId, number> = {
    rtp92: 0.9534,
    rtp945: 0.9793,
    rtp965: 1.0,
    rtp975: 1.0104,
  };
  const scale = scales[id as PresetId];
  if (scale === undefined) throw new Error(`未知预设: ${id}（可用: ${PRESET_IDS.join(', ')}）`);
  const cfg = defaultPreset();
  cfg.presetId = id;
  cfg.payoutScale = cfg.payoutScale * scale;
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
    anteScatterFactor: 1.12,
    maxWinX: 5000,
    payoutScale: 0.42,
  };
}
