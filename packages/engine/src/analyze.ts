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
import { freeSpinTriggerRate, scatterCellProbability } from './trigger';
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
  /** 免费旋转触发率：二项分布解析解（无采样误差，ENG-10） */
  fsTriggerRate: number;
  /** 同一批基础局里实测到的触发率——只作交叉校验，不参与合成 */
  fsTriggerRateSampled: number;
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
  let baseWin2 = 0; // 平方和：基础局自己也有长尾大奖，它的噪声必须计入误差条
  let baseCost = 0;
  let triggers = 0;
  let hits = 0;
  let scatterTotal = 0;
  const triggerSizes: number[] = []; // 触发时给了几次免费旋转（用于加权 E[价值]）

  for (let i = 0; i < baseSpins; i++) {
    const r = spin({ seed: `${seedPrefix}:b${i}`, bet, anteEnabled, mode: 'base', config });
    baseWin += r.totalWin;
    baseWin2 += r.totalWin * r.totalWin;
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
  const scatterPerSpin = scatterTotal / baseSpins;

  // 触发率走解析解（二项分布，无采样误差）——这曾是合成误差里最大的一块：
  // 1/154 的事件，120 万局也只见到约 7800 次，相对误差 1.1%，作用在占 RTP 六成的
  // 免费旋转通道上就是 ±0.7 个百分点，比档位间距还大。采样值只留作交叉校验。
  const fsTriggerRate = freeSpinTriggerRate(config, anteEnabled);
  const fsTriggerRateSampled = triggers / baseSpins;

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

  // ── ③ 保底通道：直接模拟 PITY_AWARD 次的段，不再用 featureValueX 折算 ──
  // 旧做法 pityValue = featureValueX × (10 / avgAward) 里，avgAward 是采样量，
  // 它的噪声没进 rtpStderr，而保底占了 RTP 的三成 ⇒ 误差被系统性低估：
  // 曾出现"锚点 ±0.10pp，各档复测却差 0.6pp（7σ）"的自相矛盾，就是这里漏的。
  let pityValueX = 0;
  let pityValueStderr = 0;
  if (includePity) {
    const pityRuns = Math.max(1, Math.round(featureRuns / 2));
    let pvSum = 0;
    let pvSum2 = 0;
    for (let i = 0; i < pityRuns; i++) {
      const w = playFeature(config, bet, `${seedPrefix}:P${i}`, PITY_AWARD) / bet;
      pvSum += w;
      pvSum2 += w * w;
    }
    pityValueX = pvSum / pityRuns;
    const pvVar = Math.max(0, pvSum2 / pityRuns - pityValueX * pityValueX);
    pityValueStderr = Math.sqrt(pvVar / pityRuns);
  }

  // ── ④ 合成 ──
  // 每 spin 的成本 = bet × costMultiplier；免费旋转价值以「×注」计
  const featureRtp = (fsTriggerRate * featureValueX) / costMultiplier;
  // 保底速度：每 spin 期望骰子数 / 100。骰子只在初盘面出现（CT-1 规则 4/6），
  // 故 E[骰子/局] = 格子数 × p(骰子) 是解析值，不必采样。
  const scatterPerSpinAnalytic = config.columns * config.rows * scatterCellProbability(config, anteEnabled);
  const pityRtp = includePity
    ? ((scatterPerSpinAnalytic / PITY_TARGET) * pityValueX) / costMultiplier
    : 0;

  const rtp = baseGameRtp + featureRtp + pityRtp;

  // 触发率与骰子率是解析值（无噪声）；三个采样量各自贡献误差，彼此独立：
  //   · 基础局 RTP —— 基础局同样有长尾大奖（可到 5000×），这一项曾被整个漏掉，
  //     导致"锚点 ±0.12pp，换个 seed 却差 0.6pp（5σ）"的自相矛盾
  //   · E[自然触发段价值]、E[保底段价值] —— 长尾，是主要噪声源
  const baseWinMean = baseWin / baseSpins;
  const baseWinVar = Math.max(0, baseWin2 / baseSpins - baseWinMean * baseWinMean);
  const baseErr = Math.sqrt(baseWinVar / baseSpins) / (bet * costMultiplier);
  const featureErr = featureRtp * (featureValueX > 0 ? featureValueStderr / featureValueX : 0);
  const pityErr = pityRtp * (pityValueX > 0 ? pityValueStderr / pityValueX : 0);
  const rtpStderr = Math.sqrt(baseErr ** 2 + featureErr ** 2 + pityErr ** 2);

  return {
    rtp,
    rtpStderr,
    baseGameRtp,
    featureRtp,
    pityRtp,
    fsTriggerRate,
    fsTriggerRateSampled,
    featureValueX,
    featureValueStderr,
    hitRate: hits / baseSpins,
    scatterPerSpin,
    costMultiplier,
    elapsedMs: Date.now() - started,
  };
}
