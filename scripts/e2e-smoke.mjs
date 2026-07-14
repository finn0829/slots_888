// V1 端到端验证：游戏可玩 + 后台可用（Playwright）
import { chromium } from 'playwright';

const SHOT = process.env.SHOT_DIR;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 800 } });
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };

// ── 游戏端 ──
await page.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const balance0 = await page.textContent('#balance');
ok(`游客自动开号，余额显示 ${balance0}`, balance0?.replace(/,/g, '') === '10000');
await page.screenshot({ path: `${SHOT}/web-1-idle.png` });

// 转 10 把，观察余额变化与动画完成
let lastBalance = 10000;
for (let i = 0; i < 10; i++) {
  await page.click('#spin');
  // 等 spin 按钮恢复可用（一局演出结束，含免费旋转自动续转）
  await page.waitForFunction(() => !document.querySelector('#spin').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(150);
}
const balanceText = await page.textContent('#balance');
lastBalance = Number(balanceText.replace(/,/g, ''));
ok(`10 把后余额变化（${balanceText}）`, lastBalance !== 10000 && lastBalance >= 0);
await page.screenshot({ path: `${SHOT}/web-2-after-spins.png` });

// 刷新页面：余额不丢（token 持久化）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const balanceAfterReload = Number((await page.textContent('#balance')).replace(/,/g, ''));
ok(`刷新后余额不丢（${balanceAfterReload}）`, balanceAfterReload === lastBalance);

// ── 服务端对账 ──
const stats = await page.evaluate(async () => {
  const login = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin888' }),
  });
  const { adminToken } = await login.json();
  const res = await fetch('/api/admin/stats', { headers: { authorization: `Bearer ${adminToken}` } });
  return res.json();
});
const today = stats.rows[0];
ok(`后台统计有今日数据（${today?.spins} spins, RTP ${today?.rtp != null ? (today.rtp * 100).toFixed(1) : '—'}%）`, (today?.spins ?? 0) >= 10);

// ── 后台端 ──
const admin = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await admin.goto('http://127.0.0.1:8790/', { waitUntil: 'networkidle' });
ok('后台登录页打开', await admin.isVisible('input[type=password]'));
await admin.screenshot({ path: `${SHOT}/admin-1-login.png` });
await admin.fill('input[type=password]', 'admin888');
await admin.click('button[type=submit]');
await admin.waitForSelector('table, .empty', { timeout: 10000 });
ok('登录后看板渲染（含真实数据表）', await admin.isVisible('table'));
await admin.screenshot({ path: `${SHOT}/admin-2-dashboard.png` });

await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length === 0 ? 0 : 1);
