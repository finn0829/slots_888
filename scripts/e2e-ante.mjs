// E2E：Ante Bet 开关（WEB-10）——价值主张展示、实扣、持久化、免费旋转期禁用
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

// 余额是滚动数字动画，轮询到两次读数相同才算稳定
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
const { costMultiplier, triggerRate, anteTriggerRate, speedup } = cfg.anteRule;
console.log(`服务端 anteRule：×${costMultiplier}，1/${Math.round(1 / triggerRate)} → 1/${Math.round(1 / anteTriggerRate)}，快 ${speedup.toFixed(2)}×`);

// ① 默认关闭
ok('默认不开启加注', !(await p.getAttribute('#ante', 'class')).includes('on'));

// ② 展示的数字来自服务端实算，不是写死的
ok(`加注条展示真实倍速（${await p.textContent('#ante-speed')} = 服务端 ${speedup.toFixed(2)}×）`,
  Math.abs(num(await p.textContent('#ante-speed')) - speedup) < 0.005);
ok(`加注条展示真实触发率（${await p.textContent('#ante-detail')}）`,
  (await p.textContent('#ante-detail')).includes(`1/${Math.round(1 / triggerRate)}`) &&
  (await p.textContent('#ante-detail')).includes(`1/${Math.round(1 / anteTriggerRate)}`));

const bet = num(await p.textContent('#bet'));
const expectCost = Math.round(bet * costMultiplier);
ok(`加注条展示实扣金额（注 ${bet} → ${expectCost} 文）`, num(await p.textContent('#ante-cost')) === expectCost);

// ③ 点击开启
await p.click('#ante');
ok('点击后进入加注状态', (await p.getAttribute('#ante', 'class')).includes('on'));
ok('下注区出现实扣提示', (await p.isVisible('#bet-cost')) && num(await p.textContent('#bet-cost')) === expectCost);
await p.screenshot({ path: `${DIR}/mobile-ante-on.png` });

// ④ 刷新后仍然开启（localStorage 持久化）
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1000);
ok('刷新后加注状态保持', (await p.getAttribute('#ante', 'class')).includes('on'));

// ⑤ 开启加注时，实际扣款是 bet × costMultiplier
const before = await balance();
await p.click('#spin');
await p.waitForTimeout(600);
const token = await p.evaluate(() => localStorage.getItem('slots888_token'));
const s1 = await p.evaluate(async (tk) => (await (await fetch('/api/stats', { headers: { authorization: `Bearer ${tk}` } })).json()), token);
ok(`服务端按加注价计入投入（本局 ${s1.totalBet} 文 = ${expectCost}）`, s1.totalBet === expectCost);
await p.waitForSelector('#spin:not([disabled])', { timeout: 20000 });
const after = await balance();
const win = num(await p.textContent('#win'));
ok(`余额按实扣结算（${before} − ${expectCost} + 赢 ${win} = ${after}）`, after === before - expectCost + win);

// ⑥ 关闭后回到原价
await p.click('#ante');
const before2 = await balance();
await p.click('#spin');
await p.waitForSelector('#spin:not([disabled])', { timeout: 20000 });
const after2 = await balance();
const win2 = num(await p.textContent('#win'));
ok(`关闭后按原注扣款（${before2} − ${bet} + 赢 ${win2} = ${after2}）`, after2 === before2 - bet + win2);

// ⑦ 规则页公示真实数字（概率诚实原则）
await p.click('#info');
await p.waitForSelector('#rules.show', { timeout: 3000 });
const rules = await p.textContent('#rules-body');
ok('规则页有「加注（Ante Bet）」章节', rules.includes('加注（Ante Bet）'));
ok(`规则页公示真实倍速（${speedup.toFixed(2)} 倍）`, rules.includes(`${speedup.toFixed(2)} 倍`));
ok('规则页公示真实触发率变化',
  rules.includes(`1/${Math.round(1 / triggerRate)}`) && rules.includes(`1/${Math.round(1 / anteTriggerRate)}`));
await p.screenshot({ path: `${DIR}/mobile-ante-rules.png` });
await p.click('#rules-close');

// ⑧ 免费旋转期间加注按钮禁用（服务端本就强制忽略，UI 必须同步）
// 用最小注刷，否则加注实扣会先把余额烧干（1/93 的触发率要几百局）
const drive = await p.evaluate(async (tk) => {
  for (let i = 0; i < 600; i++) {
    const res = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ bet: 10, anteEnabled: true }),
    });
    if (!res.ok) return { free: false, spins: i, reason: `spin 失败 HTTP ${res.status}` };
    const r = await res.json();
    if (r?.state?.freeSpinsRemaining > 0) return { free: true, spins: i + 1 };
  }
  return { free: false, spins: 600, reason: '600 局未触发' };
}, token);
console.log(`   （刷了 ${drive.spins} 局免费旋转${drive.free ? '已触发' : '未触发：' + drive.reason}）`);
if (drive.free) {
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  ok('免费旋转期间加注按钮禁用', await p.isDisabled('#ante'));
  await p.screenshot({ path: `${DIR}/mobile-ante-freespin.png` });
} else {
  ok(`免费旋转期间加注按钮禁用（未能触发免费旋转，测不到：${drive.reason}）`, false);
}

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
