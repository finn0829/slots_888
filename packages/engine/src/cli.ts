// 蒙特卡洛 CLI：npm run simulate -- --spins 1000000 --preset rtp965 [--ante]
import { getPreset, PRESET_IDS } from './config';
import { simulate } from './simulate';

const args = process.argv.slice(2);
function argOf(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}

const presetId = argOf('preset', 'rtp965');
const spins = Number(argOf('spins', '200000'));
const anteEnabled = args.includes('--ante');
const seedPrefix = argOf('seed', 'cli');

const config = getPreset(presetId);
const s = simulate(config, { spins, anteEnabled, seedPrefix });

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
console.log(JSON.stringify({
  preset: presetId,
  spins: s.spins,
  ante: anteEnabled,
  rtp: pct(s.rtp),
  hitRate: pct(s.hitRate),
  fsTriggerRate: `1/${s.fsTriggers > 0 ? Math.round(s.spins / s.fsTriggers) : '∞'}`,
  pityTriggers: s.pityTriggers,
  featureWinShare: pct(s.featureWinShare),
  maxWinX: s.maxWinX.toFixed(1),
  stdevX: s.stdevX.toFixed(2),
  elapsedMs: s.elapsedMs,
}, null, 2));
