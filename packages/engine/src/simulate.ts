import { spin } from './spin';
import type { GameConfig } from './types';

export interface SimulateOptions {
  spins: number;
  bet?: number;
  anteEnabled?: boolean;
  seedPrefix?: string;
  /** 是否模拟骰子收集保底（满 100 → 10 次免费旋转，ENG-7） */
  includePity?: boolean;
}

export interface SimulateStats {
  spins: number;
  bet: number;
  anteEnabled: boolean;
  totalCost: number;
  totalWin: number;
  /** 含免费旋转与保底的总 RTP */
  rtp: number;
  /** 有任何赢奖（含所触发免费旋转）的基础 spin 占比 */
  hitRate: number;
  hits: number;
  fsTriggers: number;
  fsTriggerRate: number;
  pityTriggers: number;
  /** 免费旋转（含保底）贡献的赢奖 */
  featureWin: number;
  featureWinShare: number;
  /** 单次 spin 总回报（×totalCost）的最大值与标准差（波动率） */
  maxWinX: number;
  stdevX: number;
  elapsedMs: number;
}

const PITY_TARGET = 100;
const PITY_AWARD = 10;
const MAX_FEATURE_SPINS = 5000;

/** 打完一整段免费旋转（含再触发），返回总赢 */
function playFeature(config: GameConfig, bet: number, seedBase: string, initialSpins: number): number {
  let remaining = initialSpins;
  let acc = 1;
  let win = 0;
  let i = 0;
  while (remaining > 0 && i < MAX_FEATURE_SPINS) {
    const r = spin({ seed: `${seedBase}:f${i}`, bet, anteEnabled: false, mode: 'free', accumulatedMultiplier: acc, config });
    win += r.totalWin;
    acc = r.accumulatedMultiplierAfter;
    remaining += r.freeSpinsAwarded - 1;
    i++;
  }
  return win;
}

export function simulate(config: GameConfig, opts: SimulateOptions): SimulateStats {
  const bet = opts.bet ?? 100;
  const anteEnabled = opts.anteEnabled ?? false;
  const seedPrefix = opts.seedPrefix ?? 'sim';
  const includePity = opts.includePity ?? true;
  const started = Date.now();

  let totalCost = 0;
  let totalWin = 0;
  let hits = 0;
  let fsTriggers = 0;
  let pityTriggers = 0;
  let featureWin = 0;
  let dice = 0;
  let maxWinX = 0;
  let sumX = 0;
  let sumX2 = 0;

  for (let i = 0; i < opts.spins; i++) {
    const seed = `${seedPrefix}:${i}`;
    const r = spin({ seed, bet, anteEnabled, mode: 'base', config });
    totalCost += r.totalCost;
    let spinReturn = r.totalWin;

    if (r.freeSpinsAwarded > 0) {
      fsTriggers++;
      const fw = playFeature(config, bet, seed, r.freeSpinsAwarded);
      featureWin += fw;
      spinReturn += fw;
    }

    if (includePity) {
      dice += r.scatterCount;
      while (dice >= PITY_TARGET) {
        dice -= PITY_TARGET;
        pityTriggers++;
        const fw = playFeature(config, bet, `${seed}:pity${pityTriggers}`, PITY_AWARD);
        featureWin += fw;
        spinReturn += fw;
      }
    }

    totalWin += spinReturn;
    if (spinReturn > 0) hits++;
    const x = spinReturn / r.totalCost;
    if (x > maxWinX) maxWinX = x;
    sumX += x;
    sumX2 += x * x;
  }

  const n = opts.spins;
  const meanX = sumX / n;
  return {
    spins: n,
    bet,
    anteEnabled,
    totalCost,
    totalWin,
    rtp: totalWin / totalCost,
    hitRate: hits / n,
    hits,
    fsTriggers,
    fsTriggerRate: fsTriggers / n,
    pityTriggers,
    featureWin,
    featureWinShare: totalWin > 0 ? featureWin / totalWin : 0,
    maxWinX,
    stdevX: Math.sqrt(Math.max(0, sumX2 / n - meanX * meanX)),
    elapsedMs: Date.now() - started,
  };
}
