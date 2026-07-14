// Ante 参数分析（ENG-6b）：用低方差分析器评估单个 anteScatterFactor
// 用法：npx tsx packages/engine/src/sweep.ts --factor 1.16 [--base 500000] [--feature 80000]
//       不传 --factor 则分析基础档（无 ante）
import { defaultPreset } from './config';
import { analyze } from './analyze';

const args = process.argv.slice(2);
const argOf = (n: string, d: number | null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
const baseSpins = argOf('base', 500_000)!;
const featureRuns = argOf('feature', 80_000)!;
const factor = argOf('factor', null);

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const cfg = defaultPreset();
if (factor !== null) cfg.anteScatterFactor = factor;

const r = analyze(cfg, {
  baseSpins,
  featureRuns,
  anteEnabled: factor !== null,
  seedPrefix: 'sweep',
});

const label = factor === null ? '基础档（无 ante）' : `Ante factor=${factor}`;
console.log(JSON.stringify({
  档位: label,
  RTP: `${pct(r.rtp)} ±${pct(r.rtpStderr)}`,
  rtpRaw: Number(r.rtp.toFixed(5)),
  基础局: pct(r.baseGameRtp),
  免费旋转: pct(r.featureRtp),
  保底: pct(r.pityRtp),
  触发率: `1/${Math.round(1 / r.fsTriggerRate)}`,
  单段均值: `${r.featureValueX.toFixed(1)}×`,
  命中率: pct(r.hitRate),
  成本倍数: r.costMultiplier.toFixed(3),
  耗时ms: r.elapsedMs,
}, null, 2));
