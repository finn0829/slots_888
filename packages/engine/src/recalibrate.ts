/**
 * ENG-10：用方差缩减分析器重校四档 RTP 预设。
 *
 * 为什么不用直测：免费旋转贡献 ~2/3 的赢奖但 ~150 局才触发一次，单次价值长尾，
 * 直接蒙特卡洛 3M 局的标准误差就有 ±1.1pp，比档位间距（1.0~2.5pp）还大。
 * analyze() 把 RTP 拆成「基础局 + 触发率 × E[单段价值] + 骰子率 × E[保底段价值]」，
 * 触发率与骰子率走二项分布解析解（零噪声），只有三个采样量各自带误差。
 *
 * ⚠️ 配对比较（同 seed 跑不同 scale）在这个引擎里**不成立**：spin.ts 在赢奖触顶 5000×
 * 时提前终止连锁，是否触顶取决于 payoutScale ⇒ 改 scale 会改变 RNG 消耗，路径整条发散。
 * 只能靠加大样本压绝对误差。
 *
 * 标定：payoutScale 是总旋钮，RTP 近似正比于它（5000× 封顶带来轻微次线性）。
 * 先线性外推，再实测校正一轮——不假设线性精确成立，用实测收尾。
 */
import { analyze } from './analyze';
import { defaultPreset } from './config';
import type { GameConfig } from './types';

const TARGETS: Array<{ id: string; target: number }> = [
  { id: 'rtp92', target: 0.92 },
  { id: 'rtp945', target: 0.945 },
  { id: 'rtp965', target: 0.965 },
  { id: 'rtp975', target: 0.975 },
];

const BASE_SCALE = defaultPreset().payoutScale;
const baseSpins = Number(process.env.BASE_SPINS ?? 2_000_000);
const featureRuns = Number(process.env.FEATURE_RUNS ?? 2_000_000);
/** 收敛判据：偏差小于这个就停（验收要求 ±0.5pp） */
const TOL = 0.0025;

function withScale(scale: number): GameConfig {
  const cfg = defaultPreset();
  cfg.payoutScale = BASE_SCALE * scale;
  return cfg;
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`;

console.log(`样本：基础局 ${baseSpins.toLocaleString()} · 免费旋转段 ${featureRuns.toLocaleString()}\n`);

const anchor = analyze(withScale(1), { baseSpins, featureRuns, seedPrefix: 'anchor' });
console.log(`锚点 scale=1.0（payoutScale=${BASE_SCALE}）：RTP ${pct(anchor.rtp)} ± ${pct(anchor.rtpStderr)}`);
console.log(`  拆解：基础局 ${pct(anchor.baseGameRtp)} + 免费旋转 ${pct(anchor.featureRtp)} + 保底 ${pct(anchor.pityRtp)}`);
console.log(`  触发率 1/${Math.round(1 / anchor.fsTriggerRate)}（解析）· 命中率 ${pct(anchor.hitRate)}\n`);

const results: Array<{ id: string; target: number; scale: number; rtp: number; stderr: number }> = [];
for (const { id, target } of TARGETS) {
  let scale = target / anchor.rtp; // 线性外推
  let got = analyze(withScale(scale), { baseSpins, featureRuns, seedPrefix: `v1-${id}` });
  console.log(`${id.padEnd(7)} 外推 scale ${scale.toFixed(4)} → 实测 ${pct(got.rtp)} ± ${pct(got.rtpStderr)}（偏差 ${pp(got.rtp - target)}）`);

  // 实测校正一轮（偏差超过容差才做；一次比例校正即可，因为响应近似线性）
  if (Math.abs(got.rtp - target) > TOL) {
    scale = scale * (target / got.rtp);
    got = analyze(withScale(scale), { baseSpins, featureRuns, seedPrefix: `v2-${id}` });
    console.log(`        校正 scale ${scale.toFixed(4)} → 实测 ${pct(got.rtp)} ± ${pct(got.rtpStderr)}（偏差 ${pp(got.rtp - target)}）`);
  }
  results.push({ id, target, scale, rtp: got.rtp, stderr: got.rtpStderr });
}

console.log('\n贴进 config.ts：');
console.log('  const scales: Record<PresetId, number> = {');
for (const r of results) console.log(`    ${r.id}: ${r.scale.toFixed(4)},   // 实测 ${pct(r.rtp)} ± ${pct(r.stderr)}`);
console.log('  };');

const worst = results.reduce((a, b) => (Math.abs(b.rtp - b.target) > Math.abs(a.rtp - a.target) ? b : a));
console.log(`\n最大偏差：${worst.id} ${pp(worst.rtp - worst.target)}（验收 ≤±0.50pp，估计噪声 ±${pct(worst.stderr)}）`);
