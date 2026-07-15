/**
 * ENG-8：标定四档 Bonus Buy 买入价倍数。
 *
 * 产品口径：买入 = 直接进入 10 次免费旋转（= 保底段），买入价按「买入档 RTP ≈ 该档公示 RTP」定，
 * 即玩家花钱买回来的期望返奖率，和正常玩这一档一样公道（概率诚实红线）。
 *
 *   买入档 RTP = E[10 次段价值 × 注] / 买入价 = valueX / buyMult
 *   令其 = nominalRtp ⇒ buyMult = valueX / nominalRtp
 *
 * valueX 用 `featureSegmentValueX`（engine 唯一真相源）直接模拟，award=10，
 * 含再触发延长与累计倍数滚雪球，**不做任何线性外推**（ENG-10 血泪：段价值超线性）。
 * 段价值是长尾采样量（封顶 5000×/spin），噪声主要来自它——用足够大的 runs 压。
 *
 * 校验：标定完再用**独立 seed** 复测一遍 valueX，算出买入档 RTP 及其误差条，
 * 证明它落在该档公示 RTP 的误差内，且不显著低于（红线）。
 */
import { featureSegmentValueX } from './analyze';
import { getPreset, PRESET_IDS } from './config';

const RUNS = Number(process.env.RUNS ?? 400_000);
const AWARD = 10;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

console.log(`Bonus Buy 标定：每档模拟 ${RUNS.toLocaleString()} 段 × ${AWARD} 次免费旋转\n`);
console.log('档位     公示RTP   E[段价值]        买入价倍数   复测买入档RTP           偏差');

const out: Array<{ id: string; buyMult: number }> = [];
for (const id of PRESET_IDS) {
  const cfg = getPreset(id);
  const nominal = cfg.nominalRtp;

  // ① 标定：用一批 seed 估 valueX，定价
  const calib = featureSegmentValueX(cfg, { award: AWARD, runs: RUNS, seedPrefix: `cal-${id}` });
  const buyMult = calib.valueX / nominal;

  // ② 校验：换独立 seed 复测 valueX，算买入档 RTP = valueX / buyMult
  const check = featureSegmentValueX(cfg, { award: AWARD, runs: RUNS, seedPrefix: `chk-${id}` });
  const buyRtp = check.valueX / buyMult;
  const buyRtpErr = check.stderr / buyMult;
  const dev = buyRtp - nominal;

  console.log(
    `${id.padEnd(8)} ${pct(nominal).padStart(7)}   ` +
    `${calib.valueX.toFixed(2)}× ±${calib.stderr.toFixed(2)}   ` +
    `${buyMult.toFixed(2).padStart(9)}   ` +
    `${pct(buyRtp)} ± ${pct(buyRtpErr)}   ${dev >= 0 ? '+' : ''}${(dev * 100).toFixed(2)}pp`,
  );
  out.push({ id, buyMult });
}

console.log('\n贴进 config.ts 的 getPreset 表（buyMult）：');
for (const { id, buyMult } of out) console.log(`    ${id}: buyMult ${buyMult.toFixed(2)},`);
console.log(`\n默认档 defaultPreset().bonusBuy.costMultiplier 必须 = getPreset('rtp965') 的 buyMult。`);
