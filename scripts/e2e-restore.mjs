// E2E：断线重连状态恢复（WEB-18）——免费旋转打到一半刷新页面，还能接着打完
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
const token = await p.evaluate(() => localStorage.getItem('slots888_token'));

// 盘面逻辑内容（像素比对不可靠：牌面有微光动画，逐帧都在变）
const boardGrid = () => p.evaluate(() => window.__board.currentGrid().map((c) => c.map((x) => x.symbol)));

// —— 场景 A：普通局刷新后，盘面恢复成上一局的终盘 ——
await p.click('#spin');
await p.waitForSelector('#spin:not([disabled])', { timeout: 20000 });
await p.waitForTimeout(600);
const beforeReload = await boardGrid();

await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
const afterReload = await boardGrid();
ok('刷新后盘面 = 刷新前的盘面（不是随机 demo 盘）',
  JSON.stringify(afterReload) === JSON.stringify(beforeReload));

// 与服务端 /api/last-spin 对账：确实是最后一局最后一次连锁的终盘
const last = await p.evaluate(async (tk) => (await (await fetch('/api/last-spin', {
  headers: { authorization: `Bearer ${tk}` },
})).json()).spin, token);
ok('/api/last-spin 返回最后一局的完整 SpinResult', last != null && Array.isArray(last.cascades));
const serverGrid = last.cascades.at(-1).gridAfter.map((c) => c.map((x) => x.symbol));
ok('恢复的盘面与服务端记录的终盘逐格一致',
  JSON.stringify(afterReload) === JSON.stringify(serverGrid));

// —— 场景 B：免费旋转打到一半刷新 ——
const free = await p.evaluate(async (tk) => {
  for (let i = 0; i < 600; i++) {
    const res = await fetch('/api/spin', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ bet: 10, anteEnabled: true }),
    });
    if (!res.ok) return { got: false, reason: `spin HTTP ${res.status}` };
    const r = await res.json();
    if (r.state.freeSpinsRemaining > 0) return { got: true, remaining: r.state.freeSpinsRemaining };
  }
  return { got: false, reason: '600 局未触发' };
}, token);
ok(`刷到免费旋转（还剩 ${free.remaining ?? '—'} 次）`, free.got);

if (free.got) {
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2200);

  ok('免费旋转横幅提示玩家还剩几次、怎么继续',
    (await p.textContent('#banner-text')).includes('免费旋转')
    && /还剩 \d+ 次/.test(await p.textContent('#banner-sub')));
  await p.screenshot({ path: `${DIR}/mobile-restore-freespin.png` });
  await p.click('.banner').catch(() => {});
  await p.waitForTimeout(800);

  ok('免费旋转条显示剩余次数与累计倍数', await p.isVisible('#freespins'));
  ok(`剩余次数与服务端一致（${await p.textContent('#freespins-count')} = ${free.remaining}）`,
    num(await p.textContent('#freespins-count')) === free.remaining);

  const spinBtn = await p.textContent('#spin');
  ok(`开局键改口播为「继续」（现为「${spinBtn.trim()}」）`, spinBtn.includes('继续') || spinBtn.includes('继 续'));
  ok('开局键在呼吸（免费旋转不扣钱，余额再低也该招手）',
    ((await p.getAttribute('#spin', 'class')) ?? '').includes('attract'));
  ok('开局键可点', !(await p.isDisabled('#spin')));

  // 真的点下去，把免费旋转继续打
  const before = free.remaining;
  await p.click('#spin');
  await p.waitForTimeout(2500);
  const after = await p.evaluate(async (tk) => (await (await fetch('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tk }),
  })).json()).state.freeSpinsRemaining, token);
  ok(`点「继续」后免费旋转真的接着打（剩余 ${before} → ${after}）`, after < before);
}

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
