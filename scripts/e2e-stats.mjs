// E2E：玩家个人统计（总投入/总赢奖/净额/实测 RTP）与服务端数据对账
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

await p.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

// 新玩家：全 0
await p.click('#stats-btn');
await p.waitForSelector('.stats-grid', { timeout: 5000 });
ok('新玩家净额为 0', num(await p.textContent('.stats-hero b')) === 0);
ok('新玩家 RTP 显示 —（无投入不谈返奖率）', (await p.textContent('.stats-rtp-head b')).trim() === '—');
await p.click('#stats-close');

// 转 30 把
const token = await p.evaluate(() => localStorage.getItem('slots888_token'));
await p.evaluate(async (tk) => {
  for (let i = 0; i < 30; i++) {
    await fetch('/api/spin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ bet: 100, anteEnabled: false }),
    });
  }
}, token);

// 打开战绩，与服务端 /api/stats 逐字段对账
await p.click('#stats-btn');
await p.waitForSelector('.stats-grid', { timeout: 5000 });
const api = await p.evaluate(async (tk) => (await (await fetch('/api/stats', {
  headers: { authorization: `Bearer ${tk}` },
})).json()), token);

const cells = await p.$$eval('.stats-grid > div', (els) =>
  Object.fromEntries(els.map((el) => [el.querySelector('span').textContent, el.querySelector('b').textContent])));

ok(`总投入一致（UI ${cells['总投入']} = API ${api.totalBet}）`, num(cells['总投入']) === api.totalBet);
ok(`总赢奖一致（UI ${cells['总赢奖']} = API ${api.totalWin}）`, num(cells['总赢奖']) === api.totalWin);
ok(`总局数一致（UI ${cells['总局数']} = API ${api.totalSpins}）`, num(cells['总局数']) === api.totalSpins);
ok(`净额 = 总赢奖 − 总投入（${api.net}）`, num(await p.textContent('.stats-hero b')) === api.net);
ok(`实测 RTP = 总赢奖 ÷ 总投入（${(api.rtp * 100).toFixed(1)}%）`,
  Math.abs(num(await p.textContent('.stats-rtp-head b')) - api.rtp * 100) < 0.15);
ok('净额为负时显示红色（诚实展示亏损）',
  api.net >= 0 || (await p.getAttribute('.stats-hero', 'class')).includes('down'));
await p.screenshot({ path: `${DIR}/mobile-stats.png` });

// 签到的钱不算进"赢奖"
await p.click('#stats-close');
if (await p.isVisible('#claim-daily')) {
  const winBefore = api.totalWin;
  await p.click('#claim-daily');
  await p.waitForSelector('.banner.show');
  await p.click('.banner');
  await p.waitForTimeout(700);
  const after = await p.evaluate(async (tk) => (await (await fetch('/api/stats', {
    headers: { authorization: `Bearer ${tk}` },
  })).json()), token);
  ok(`签到 +1000 不计入总赢奖（仍为 ${after.totalWin}）`, after.totalWin === winBefore);
  ok('签到金额计入「领取补贴」', after.bonusReceived === 1000);
}

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
