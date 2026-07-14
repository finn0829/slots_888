// E2E：后台一键补币（ADM-5b）——测试时余额打空了，去后台点一下就能接着玩
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const TOPUP = 1_000_000;
const browser = await chromium.launch();
const errors = [];
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

// —— 先在游戏页开一个玩家，把余额打到接近见底 ——
const game = await browser.newPage({ viewport: { width: 390, height: 844 } });
game.on('pageerror', (e) => errors.push(`[game] ${e}`));
await game.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await game.waitForTimeout(1200);
const token = await game.evaluate(() => localStorage.getItem('slots888_token'));
const playerId = await game.evaluate(async (tk) => {
  const r = await (await fetch('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tk }),
  })).json();
  return r.state.playerId;
}, token);

// 用最大注刷到余额不够开局（模拟"每天 100 下就打完了"的处境）
const broke = await game.evaluate(async (tk) => {
  for (let i = 0; i < 300; i++) {
    const res = await fetch('/api/spin', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ bet: 500, anteEnabled: false }),
    });
    if (!res.ok) return true; // 余额不足，spin 被拒
    const r = await res.json();
    if (r.state.balance < 500 && r.state.freeSpinsRemaining === 0) return true;
  }
  return false;
}, token);
ok('玩家把余额打空了（复现"很快就打完"的处境）', broke);

const balanceOf = async (tk) => game.evaluate(async (t) => (await (await fetch('/api/session', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }),
})).json()).state.balance, tk);
const before = await balanceOf(token);
console.log(`   玩家 #${playerId} 当前余额 ${before}`);

// —— 后台一键补币 ——
const adm = await browser.newPage({ viewport: { width: 1360, height: 860 } });
adm.on('pageerror', (e) => errors.push(`[admin] ${e}`));
const dialogs = [];
adm.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });

await adm.goto('http://127.0.0.1:8790/', { waitUntil: 'networkidle' });
await adm.fill('input[type=password]', 'admin888');
await adm.click('button[type=submit]');
await adm.waitForSelector('nav a', { timeout: 15000 });
await adm.click('nav a:has-text("玩家管理")');
// 看板上本来就有 table，必须等玩家管理这一页真的渲染出来再断言
await adm.waitForSelector('h2:has-text("玩家管理")', { timeout: 15000 });
await adm.waitForSelector('table tbody tr', { timeout: 15000 });

const row = adm.locator(`tbody tr:has(td:text-is("#${playerId}"))`);
ok('玩家管理页能找到该玩家', (await row.count()) === 1);

const quick = row.locator('button:has-text("补 100 万")');
ok('该玩家行有「补 100 万」一键按钮', (await quick.count()) === 1);
if (await quick.count()) {
  await quick.click();
  await adm.waitForFunction(
    ([id, want]) => {
      const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.querySelector('td')?.textContent === `#${id}`);
      return tr && Number(tr.children[2].textContent.replace(/[^\d]/g, '')) === want;
    },
    [playerId, before + TOPUP],
    { timeout: 15000 },
  );
  ok('一次点击即补币（只弹一次确认，无需手输金额）', dialogs.length === 1);
  ok(`确认框写明金额（${dialogs[0] ?? ''}）`, /100\s*万|1,000,000/.test(dialogs[0] ?? ''));
  ok(`表格余额更新为 ${(before + TOPUP).toLocaleString()}`,
    num(await row.locator('td').nth(2).textContent()) === before + TOPUP);
  await adm.screenshot({ path: `${DIR}/admin-quick-topup.png` });

  // —— 玩家侧：刷新即可接着玩 ——
  const after = await balanceOf(token);
  ok(`服务端余额 = 补币前 + 100 万（${before} + ${TOPUP} = ${after}）`, after === before + TOPUP);
  await game.reload({ waitUntil: 'networkidle' });
  await game.waitForTimeout(1500);
  ok('游戏页刷新后余额到账，可以接着玩', num(await game.textContent('#balance')) === after);
  ok('开局按钮恢复可用', !(await game.isDisabled('#spin')));
  await game.screenshot({ path: `${DIR}/admin-quick-topup-game.png` });

  // —— 审计：补币必须留痕，且不能计入"赢奖" ——
  const stats = await game.evaluate(async (tk) => (await (await fetch('/api/stats', {
    headers: { authorization: `Bearer ${tk}` },
  })).json()), token);
  ok(`补币不计入总赢奖（totalWin ${stats.totalWin} 不含 100 万）`, stats.totalWin < TOPUP);
  ok(`补币计入「领取补贴」（bonusReceived ${stats.bonusReceived}）`, stats.bonusReceived >= TOPUP);

  const ops = await adm.evaluate(async () => (await (await fetch('/api/admin/ops?page=1', {
    headers: { authorization: `Bearer ${sessionStorage.getItem('slots888_admin_token') ?? ''}` },
  })).json()));
  const logged = JSON.stringify(ops).includes('player_credit');
  ok('管理操作日志记下了这次补币（player_credit）', logged);
}

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
