// 方差缩减分析器（ENG-6b）
//
// 直接蒙特卡洛测 RTP 的噪声极大：免费旋转贡献了 ~66% 的赢奖，但它 ~150 局才触发一次，
// 且单次价值长尾（封顶 5000×）。5M 次直测的标准误差仍有 ±1%，2M 次 ±3%——
// 比要调的参数效应还大，无法用于调参。
//
// 解法：把 RTP 拆成三个独立量，各自用最省样本的方式估计，再解析合成：
//   RTP = 基础局RTP + 触发率 × E[单次免费旋转价值] / 注   （+ 保底通道，同理）
//
//   · 基础局 RTP：每局都有观测，方差小，几十万次即收敛
//   · 触发率：伯努利频率，方差小
//   · E[免费旋转价值]：直接模拟 M 段免费旋转（不必等自然触发），
//     用 M=20 万段 ≈ 等价于 3000 万次自然 spin 的信息量
import { spin } from './spin';
import type { GameConfig } from './types';

export interface AnalyzeOptions {
  /** 基础局样本数（估基础局 RTP + 触发率 + 骰子率） */
  baseSpins?: number;
  /** 免费旋转段样本数（估 E[单段价值]） */
  featureRuns?: number;
  bet?: number;
  anteEnabled?: boolean;
  seedPrefix?: string;
  /** 是否计入骰子收集保底通道 */
  includePity?: boolean;
}

export interface AnalyzeResult {
  /** 合成总 RTP */
  rtp: number;
  /** ±1 标准误差（合成后的估计精度） */
  rtpStderr: number;
  baseGameRtp: number;
  /** 免费旋转（自然触发）贡献的 RTP */
  featureRtp: number;
  /** 保底通道贡献的 RTP */
  pityRtp: number;
  fsTriggerRate: number;
  /** 单段免费旋转的期望价值（×注） */
  featureValueX: number;
  featureValueStderr: number;
  hitRate: number;
  /** 每 spin 期望骰子数（决定保底速度） */
  scatterPerSpin: number;
  costMultiplier: number;
  elapsedMs: number;
}

const MAX_FEATURE_SPINS = 5000;
const PITY_TARGET = 100;
const PITY_AWARD = 10;

/** 打完一整段免费旋转（含再触发），返回总赢（文） */
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

export function analyze(config: GameConfig, opts: AnalyzeOptions = {}): AnalyzeResult {
  const baseSpins = opts.baseSpins ?? 400_000;
  const featureRuns = opts.featureRuns ?? 60_000;
  const bet = opts.bet ?? 100;
  const anteEnabled = opts.anteEnabled ?? false;
  const seedPrefix = opts.seedPrefix ?? 'az';
  const includePity = opts.includePity ?? true;
  const started = Date.now();

  // ── ① 基础局：RTP、触发率、命中率、骰子率（每局都有观测，低方差）──
  let baseWin = 0;
  let baseCost = 0;
  let triggers = 0;
  let hits = 0;
  let scatterTotal = 0;
  const triggerSizes: number[] = []; // 触发时给了几次免费旋转（用于加权 E[价值]）

  for (let i = 0; i < baseSpins; i++) {
    const r = spin({ seed: `${seedPrefix}:b${i}`, bet, anteEnabled, mode: 'base', config });
    baseWin += r.totalWin;
    baseCost += r.totalCost;
    if (r.totalWin > 0) hits++;
    scatterTotal += r.scatterCount;
    if (r.freeSpinsAwarded > 0) {
      triggers++;
      triggerSizes.push(r.freeSpinsAwarded);
    }
  }

  const costMultiplier = baseCost / (baseSpins * bet);
  const baseGameRtp = baseWin / baseCost;
  const fsTriggerRate = triggers / baseSpins;
  const scatterPerSpin = scatterTotal / baseSpins;

  // 自然触发时免费旋转次数的分布（多数是 10 次；骰子越多次数越多）
  const avgAward = triggerSizes.length > 0
    ? triggerSizes.reduce((a, b) => a + b, 0) / triggerSizes.length
    : config.freeSpins.base;

  // ── ② 免费旋转单段价值：直接模拟，不等自然触发（关键的方差缩减）──
  let fvSum = 0;
  let fvSum2 = 0;
  for (let i = 0; i < featureRuns; i++) {
    // 按自然触发的次数分布取样（少数大额触发同样被覆盖）
    const award = triggerSizes.length > 0
      ? triggerSizes[i % triggerSizes.length]!
      : Math.round(avgAward);
    const w = playFeature(config, bet, `${seedPrefix}:F${i}`, award) / bet;
    fvSum += w;
    fvSum2 += w * w;
  }
  const featureValueX = fvSum / featureRuns;
  const fvVar = Math.max(0, fvSum2 / featureRuns - featureValueX * featureValueX);
  const featureValueStderr = Math.sqrt(fvVar / featureRuns);

  // ── ③ 合成 ──
  // 每 spin 的成本 = bet × costMultiplier；免费旋转价值以「×注」计
  const featureRtp = (fsTriggerRate * featureValueX) / costMultiplier;

  // 保底通道：每 spin 累计 scatterPerSpin 个骰子，满 100 得 PITY_AWARD 次免费旋转
  let pityRtp = 0;
  if (includePity) {
    const pityRatePerSpin = scatterPerSpin / PITY_TARGET;
    // 保底给的是固定 PITY_AWARD 次，价值按比例折算
    const pityValueX = featureValueX * (PITY_AWARD / avgAward);
    pityRtp = (pityRatePerSpin * pityValueX) / costMultiplier;
  }

  const rtp = baseGameRtp + featureRtp + pityRtp;

  // 误差主要来自 E[单段价值]；触发率的相对误差也计入
  const triggerRelErr = triggers > 0 ? 1 / Math.sqrt(triggers) : 1;
  const featureRelErr = featureValueX > 0 ? featureValueStderr / featureValueX : 0;
  const featurePart = featureRtp + pityRtp;
  const rtpStderr = featurePart * Math.sqrt(triggerRelErr ** 2 + featureRelErr ** 2);

  return {
    rtp,
    rtpStderr,
    baseGameRtp,
    featureRtp,
    pityRtp,
    fsTriggerRate,
    featureValueX,
    featureValueStderr,
    hitRate: hits / baseSpins,
    scatterPerSpin,
    costMultiplier,
    elapsedMs: Date.now() - started,
  };
}
