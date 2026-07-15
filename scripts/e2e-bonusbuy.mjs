// E2E：Bonus Buy 买入免费旋转（WEB-15）——服务端下发的买入价、二次确认、扣款、
// 复用 WEB-18「还剩 N 次 · 点继续」横幅、个人统计对账、免费旋转期按钮隐藏。
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
// 买入有 window.confirm 二次确认，一律接受
p.on('dialog', (d) => void d.accept());
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

async function balance() {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const v = num(await p.textContent('#balance'));
    if (v === prev) return v;
    prev = v;
    await p.waitForTimeout(120);
  }
  return prev;
}

await p.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

const cfg = await p.evaluate(async () => (await (await fetch('/api/config')).json()));
ok('配置下发 bonusBuy 字段', cfg.bonusBuy && typeof cfg.bonusBuy.costMultiplier === 'number');
if (!cfg.bonusBuy.enabled) {
  ok('Bonus Buy 未开启（跳过买入流程）', false);
  await browser.close();
  process.exit(1);
}
const bet = num(await p.textContent('#bet'));
const expectCost = Math.round(bet * cfg.bonusBuy.costMultiplier);
console.log(`服务端 bonusBuy：${cfg.bonusBuy.costMultiplier}× · 注 ${bet} → 买入价 ${expectCost} 文`);

// ① 买入按钮可见，且成本来自服务端下发值（非写死）
ok('买入按钮可见', await p.isVisible('#bonus-buy'));
ok(`买入按钮展示服务端算的价（${await p.textContent('#bonus-buy-cost')} = ${expectCost} 文）`,
  num(await p.textContent('#bonus-buy-cost')) === expectCost);
await p.screenshot({ path: `${DIR}/mobile-bonusbuy.png` });

// ② 点击买入 → 接受确认 → 扣款、进入 10 次免费旋转、横幅提示、按钮改「继续」
const before = await balance();
await p.click('#bonus-buy');
await p.waitForSelector('#banner.show', { timeout: 4000 });
ok('买入后弹出「买入成功」横幅', (await p.textContent('#banner-text')).includes('买入成功'));
await p.click('#banner'); // 关横幅
await p.waitForTimeout(300);
const after = await balance();
ok(`余额扣掉买入价（${before} − ${expectCost} = ${after}）`, after === before - expectCost);
ok('进入免费旋转（剩余 10 次）', num(await p.textContent('#freespins-count')) === 10);
ok('开局键改口播「继续」', (await p.textContent('#spin')).includes('继'));
ok('免费旋转期间买入按钮隐藏', !(await p.isVisible('#bonus-buy')));

// ③ 服务端计入总投入（个人统计对账）
const token = await p.evaluate(() => localStorage.getItem('slots888_token'));
const stats1 = await p.evaluate(async (tk) => (await (await fetch('/api/stats', { headers: { authorization: `Bearer ${tk}` } })).json()), token);
ok(`买入花费计入总投入（bonusBuySpent ${stats1.bonusBuySpent} = ${expectCost}）`, stats1.bonusBuySpent === expectCost);
ok(`总投入含买入价（totalBet ${stats1.totalBet} ≥ ${expectCost}）`, stats1.totalBet >= expectCost);

// ④ 把 10 次免费旋转打完，再对账 RTP = 总赢 / 总投入
for (let i = 0; i < 20; i++) {
  const remaining = num(await p.textContent('#freespins-count'));
  if (remaining <= 0) break;
  await p.click('#spin');
  await p.waitForSelector('#spin:not([disabled])', { timeout: 20000 });
  // 关键：等免费次数真的递减（或归零）再进下一轮——否则按钮 re-enable 早于
  // #freespins-count 的 DOM 更新，会读到陈旧值多点一次，那一下服务端已 0 次
  // 免费旋转 ⇒ 变成一个基础局（多计 1 注投入），是本 e2e 的时序竞态而非产品 bug。
  await p
    .waitForFunction(
      (prev) => {
        const el = document.querySelector('#freespins-count');
        const v = el ? Number(el.textContent) : 0;
        return v < prev || v === 0;
      },
      remaining,
      { timeout: 20000 },
    )
    .catch(() => {});
  await p.waitForTimeout(200);
}
const stats2 = await p.evaluate(async (tk) => (await (await fetch('/api/stats', { headers: { authorization: `Bearer ${tk}` } })).json()), token);
console.log(`   打完免费旋转：总投入 ${stats2.totalBet}（含买入 ${stats2.bonusBuySpent}）· 总赢 ${stats2.totalWin} · RTP ${stats2.rtp === null ? '—' : (stats2.rtp * 100).toFixed(1) + '%'}`);
ok('免费旋转不额外增加投入（总投入仍 = 买入价）', stats2.totalBet === expectCost);
ok('个人 RTP 自洽（总赢 / 总投入）', stats2.rtp === null ? stats2.totalWin === 0 : Math.abs(stats2.rtp - stats2.totalWin / stats2.totalBet) < 1e-6);
ok('打完后买入按钮重新出现', await p.isVisible('#bonus-buy'));

// ⑤ 规则页公示买入价（概率诚实原则）
await p.click('#info');
await p.waitForSelector('#rules.show', { timeout: 3000 });
const rules = await p.textContent('#rules-body');
ok('规则页有「买入免费旋转」章节', rules.includes('买入免费旋转'));
ok(`规则页公示服务端买入价（${expectCost} 文）`, rules.includes(String(expectCost.toLocaleString('zh-CN'))) || rules.includes(String(expectCost)));
await p.screenshot({ path: `${DIR}/mobile-bonusbuy-rules.png` });
await p.click('#rules-close');

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
