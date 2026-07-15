// E2E：公示 RTP 随配置下发（ENG-10）——规则页的数字不能写死，改配置它必须跟着变
import { chromium } from 'playwright';

const DIR = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const errors = [];
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };

const game = await browser.newPage({ viewport: { width: 390, height: 844 } });
game.on('pageerror', (e) => errors.push(String(e)));
await game.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await game.waitForTimeout(1200);

const cfg = await game.evaluate(async () => (await (await fetch('/api/config')).json()));
console.log(`   服务端下发 rtp = ${(cfg.rtp * 100).toFixed(1)}%（配置版本 v${cfg.version}）`);

const rulesText = async () => {
  await game.click('#info');
  await game.waitForSelector('#rules.show', { timeout: 3000 });
  const t = await game.textContent('#rules-body');
  await game.click('#rules-close');
  await game.waitForTimeout(300);
  return t;
};

const statsText = async () => {
  await game.click('#stats-btn');
  await game.waitForSelector('#stats.show', { timeout: 3000 });
  await game.waitForFunction(() => !/统计中/.test(document.querySelector('#stats-body')?.textContent ?? '统计中'), null, { timeout: 5000 });
  const t = await game.textContent('#stats-body');
  await game.click('#stats-close');
  await game.waitForTimeout(300);
  return t;
};

const t1 = await rulesText();
const shown = `${(cfg.rtp * 100).toFixed(1)}%`;
ok(`规则页公示的 RTP = 服务端下发值（${shown}）`, t1.includes(`约 ${shown}`));
ok('规则页仍声明"不存在连败后暗中调整概率"', t1.includes('不存在连败后暗中调整概率的机制'));
ok('不再出现写死的旧值 95.6%', !t1.includes('约 95.6%') || shown === '95.6%');

// 战绩面板的"理论值"同样必须走服务端下发值（此前写死 95.6%，是诚实红线漏网）
const st1 = await statsText();
ok(`战绩页理论值 = 服务端下发值（${shown}）`, st1.includes(shown));
ok('战绩页不再写死 95.6%', !st1.includes('95.6%') || shown === '95.6%');
await game.click('#info');
await game.waitForSelector('#rules.show');
await game.screenshot({ path: `${DIR}/mobile-rules-rtp.png` });
await game.click('#rules-close');

// —— 后台把生效配置切到 92 档 → 玩家侧公示必须跟着降 ——
const adm = await browser.newPage({ viewport: { width: 1360, height: 860 } });
adm.on('pageerror', (e) => errors.push(`[admin] ${e}`));
adm.on('dialog', (d) => void d.accept());
await adm.goto('http://127.0.0.1:8790/', { waitUntil: 'networkidle' });
await adm.fill('input[type=password]', 'admin888');
await adm.click('button[type=submit]');
await adm.waitForSelector('nav a', { timeout: 15000 });
await adm.click('nav a:has-text("配置管理")');
await adm.waitForSelector('tbody tr .badge.published', { timeout: 15000 });
await adm.selectOption('.actions-row select', 'rtp92');
await adm.click('button:has-text("从预设新建草稿")');
await adm.waitForSelector('.editor', { timeout: 15000 });
await adm.click('.editor-ops button:has-text("发布")');
await adm.waitForFunction(() => !document.querySelector('.editor'), null, { timeout: 20000 });

const cfg2 = await game.evaluate(async () => (await (await fetch('/api/config')).json()));
ok(`发布 92 档后服务端 rtp 降到 ${(cfg2.rtp * 100).toFixed(1)}%`, cfg2.rtp < cfg.rtp && Math.abs(cfg2.rtp - 0.922) < 0.005);

await game.reload({ waitUntil: 'networkidle' });
await game.waitForTimeout(1500);
const t2 = await rulesText();
const shown2 = `${(cfg2.rtp * 100).toFixed(1)}%`;
ok(`规则页公示跟着变成 ${shown2}（证明不是写死的）`, t2.includes(`约 ${shown2}`) && !t2.includes(`约 ${shown}`));

const st2 = await statsText();
ok(`战绩页理论值跟着变成 ${shown2}（证明不是写死的）`, st2.includes(shown2) && !st2.includes(shown));

ok('浏览器无 JS 异常', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
