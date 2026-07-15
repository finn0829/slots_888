// E2E：赢奖历史（WEB-14）——打几局 → 开战绩看「最近记录」→ 展开某条看终盘盘面
// 盘面用逻辑网格（data-sym）比对，不做像素比对（牌面有微光动画，逐帧都在变）
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
const api = (path) => p.evaluate(async ([path, tk]) =>
  (await (await fetch(path, { headers: { authorization: `Bearer ${tk}` } })).json()),
  [path, token]);

// —— 打若干局，凑出历史 ——
const N = 6;
for (let i = 0; i < N; i++) {
  await p.click('#spin');
  await p.waitForSelector('#spin:not([disabled])', { timeout: 20000 });
  await p.waitForTimeout(250);
}

// —— 打开战绩面板，历史应自动加载 ——
await p.click('#stats-btn');
await p.waitForSelector('#history-list .hist-row', { timeout: 8000 });
const rowCount = await p.locator('#history-list .hist-row').count();
ok(`「最近记录」列出至少 ${N} 局（现 ${rowCount} 条）`, rowCount >= N);

// —— 与 /api/history 逐条对账 ——
const server = await api('/api/history?limit=20');
ok('/api/history 返回 history 数组', Array.isArray(server.history));
const domIds = await p.evaluate(() =>
  [...document.querySelectorAll('#history-list .hist-row')].map((el) => Number(el.dataset.spinId)));
const serverIds = server.history.map((r) => r.spinId);
ok('DOM 条目的 spinId 与服务端一致（顺序、内容）',
  JSON.stringify(domIds) === JSON.stringify(serverIds));
ok('降序（最新在最上）', JSON.stringify(serverIds) === JSON.stringify([...serverIds].sort((a, b) => b - a)));

// 第一条的赢奖/倍数文案与服务端字段一致
const top = server.history[0];
const topWinTxt = await p.textContent('#history-list .hist-row:first-child .hist-win');
if (top.totalWin > 0) {
  ok(`首条赢奖文案含 ${top.totalWin}`, num(topWinTxt) === top.totalWin);
} else {
  ok('首条无赢奖显示「—」', topWinTxt.trim() === '—');
}

// —— 点开一条，看终盘小盘面；逻辑网格与服务端 finalGrid 逐格比对 ——
const targetId = server.history[0].spinId;
await p.click(`.hist-head[data-toggle="${targetId}"]`);
await p.waitForSelector(`#hist-board-${targetId}.show .mini-cell`, { timeout: 4000 });
const domGrid = await p.evaluate((id) => {
  const cells = [...document.querySelectorAll(`#hist-board-${id} .mini-cell`)];
  // DOM 按 5 行 × 6 列铺开（row-major）；还原成 grid[col][row]
  const grid = Array.from({ length: 6 }, () => Array(5).fill(null));
  cells.forEach((el, i) => { const row = Math.floor(i / 6), col = i % 6; grid[col][row] = el.dataset.sym; });
  return grid;
}, targetId);
const serverGrid = server.history[0].finalGrid.map((c) => c.map((x) => x.symbol));
ok('展开的终盘盘面与服务端 finalGrid 逐格一致（逻辑网格比对）',
  JSON.stringify(domGrid) === JSON.stringify(serverGrid));
await p.screenshot({ path: `${DIR}/mobile-history-expanded.png` });

// 再点一次收起
await p.click(`.hist-head[data-toggle="${targetId}"]`);
await p.waitForTimeout(300);
ok('再次点击收起盘面', !(await p.evaluate((id) =>
  document.getElementById(`hist-board-${id}`).classList.contains('show'), targetId)));

// —— 「加载更多」翻页：若不足一页则按钮隐藏 ——
const moreVisible = await p.isVisible('#history-more');
ok(`记录仅 ${rowCount} 条（不足一页）→「加载更多」隐藏`, rowCount < 20 ? !moreVisible : true);

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
