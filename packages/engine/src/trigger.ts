// 免费旋转触发率的解析计算（WEB-10）
//
// 骰子只看首盘面（CT-1 规则 4），30 格独立同分布，出现 ≥trigger 个即触发。
// 这是标准二项分布，可精确算——不必模拟，也就不会有采样噪声。
//
// 为什么要解析算：前端要向玩家公示「Ante 让免费旋转快 N 倍」。若把 N 硬编码，
// 后台一改权重它就成了谎言。解析计算保证这个数字永远与当前生效配置一致。
import { NORMAL_SYMBOLS } from './grid';
import type { GameConfig } from './types';

/** 首盘面上单格出现骰子的概率 */
export function scatterCellProbability(config: GameConfig, anteEnabled: boolean): number {
  let total = 0;
  for (const s of NORMAL_SYMBOLS) total += config.symbols[s].weight;
  total += config.wildWeight;
  const scatter = config.scatterWeight * (anteEnabled ? config.anteScatterFactor : 1);
  total += scatter;
  // 注：金牌只在免费旋转出现，不参与基础局首盘面的权重表
  return scatter / total;
}

/** 二项分布 P(X ≥ k)，X ~ B(n, p) */
function binomialAtLeast(n: number, p: number, k: number): number {
  if (p <= 0) return k <= 0 ? 1 : 0;
  if (p >= 1) return 1;
  // 逐项递推累加 P(X = i)，避免大数阶乘
  const q = 1 - p;
  let term = Math.pow(q, n); // P(X = 0)
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= ((n - i + 1) / i) * (p / q);
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** 每次基础局 spin 触发免费旋转的概率（解析值，无采样误差） */
export function freeSpinTriggerRate(config: GameConfig, anteEnabled: boolean): number {
  const cells = config.columns * config.rows;
  const p = scatterCellProbability(config, anteEnabled);
  return binomialAtLeast(cells, p, config.freeSpins.trigger);
}

/** Ante 让免费旋转快多少倍——公示给玩家的价值主张，随配置自动同步 */
export function anteSpeedup(config: GameConfig): number {
  const base = freeSpinTriggerRate(config, false);
  if (base <= 0) return 1;
  return freeSpinTriggerRate(config, true) / base;
}
