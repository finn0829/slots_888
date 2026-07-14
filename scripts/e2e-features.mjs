// E2E：自动旋转 / 规则页 / 经济缓冲（签到·救济）
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const bal = async () => Number((await p.textContent('#balance')).replace(/,/g, ''));
const settle = async () => {
  let prev = await p.textContent('#balance');
  for (let i = 0; i < 25; i++) {
    await p.waitForTimeout(200);
    const now = await p.textContent('#balance');
    if (now === prev) return;
    prev = now;
  }
};

await p.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

// ── 规则页 ──
await p.click('#info');
await p.waitForSelector('.rules.show', { timeout: 5000 });
const rulesText = await p.textContent('#rules-body');
ok('规则页打开且含赔付表', await p.isVisible('.rules-pt .pt-row'));
ok('规则页公示 RTP', /RTP（返奖率）约 95\.6%/.test(rulesText));
ok('规则页说明保底与连锁倍数', /集满 100 必得 10 次/.test(rulesText) && /×1 → ×2 → ×3 → ×5 → ×10/.test(rulesText));
await p.screenshot({ path: `${DIR}/mobile-rules.png` });
await p.click('#rules-close');
ok('规则页可关闭', !(await p.isVisible('.rules.show')));

// ── 每日签到 ──
ok('签到按钮可见（新玩家）', await p.isVisible('#claim-daily'));
const before = await bal();
await p.click('#claim-daily');
await p.waitForSelector('.banner.show', { timeout: 5000 });
await p.click('.banner');
await settle();
ok(`签到到账 +1000（${before} → ${await bal()}）`, (await bal()) === before + 1000);
ok('签到后按钮消失（当日已领）', !(await p.isVisible('#claim-daily')));

// ── 自动旋转 ──
await p.click('#auto');
await p.waitForSelector('.auto-panel.show', { timeout: 3000 });
await p.screenshot({ path: `${DIR}/mobile-autospin-panel.png` });
await p.click('.auto-counts button[data-n="10"]');
await p.waitForTimeout(600);
const autoText = await p.textContent('#auto');
ok(`自动旋转启动（按钮显示「${autoText}」）`, /停 \d+/.test(autoText));
ok('自动期间 spin 按钮禁用', await p.isDisabled('#spin'));

// 等它跑完（免费旋转触发会提前停止，也算正常结束）
await p.waitForFunction(() => document.querySelector('#auto').textContent === '自动', null, { timeout: 180000 });
ok('自动旋转跑完并自行停止', (await p.textContent('#auto')) === '自动');
await settle();

// ── 手动停止 ──
await p.click('#auto');
await p.click('.auto-counts button[data-n="100"]');
await p.waitForTimeout(900);
await p.click('#auto'); // 再点=停止
await p.waitForFunction(() => document.querySelector('#auto').textContent === '自动', null, { timeout: 60000 });
ok('自动旋转可手动中断', (await p.textContent('#auto')) === '自动');

// ── 破产救济 ──
await p.evaluate(async () => {
  // 把余额烧到不够最低注：直接用最大注狂转（服务端权威，前端无法作弊）
});
const token = await p.evaluate(() => localStorage.getItem('slots888_token'));
await p.evaluate(async (tk) => {
  for (let i = 0; i < 400; i++) {
    const me = await (await fetch('/api/me', { headers: { authorization: `Bearer ${tk}` } })).json();
    if (me.state.balance < 10) break;
    const bet = [500, 200, 100, 50, 20, 10].find((b) => b <= me.state.balance);
    if (!bet) break;
    const r = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ bet, anteEnabled: false }),
    });
    if (!r.ok) break;
  }
}, token);
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const broke = await bal();
ok(`余额已烧到破产（${broke} < 10）`, broke < 10);
ok('救济按钮出现', await p.isVisible('#claim-relief'));
await p.click('#claim-relief');
await p.waitForSelector('.banner.show', { timeout: 5000 });
await p.click('.banner');
await settle();
ok(`救济金到账 +2000（${broke} → ${await bal()}）`, (await bal()) === broke + 2000);
ok('领取后救济按钮消失（冷却中）', !(await p.isVisible('#claim-relief')));

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
