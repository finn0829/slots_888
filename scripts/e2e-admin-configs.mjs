import { chromium } from '/home/lucas/code/finn_semfoundry_com/node_modules/playwright/index.mjs';
const DIR = '/home/lucas/code/finn_semfoundry_com/docs/screenshots/p0-after';
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('dialog', (d) => void d.accept());
const fails = [];
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) fails.push(name); };
const cfgVersion = () => p.evaluate(async () => (await (await fetch('/api/config')).json()).version);

await p.goto('http://127.0.0.1:8790/', { waitUntil: 'networkidle' });
await p.fill('input[type=password]', 'admin888');
await p.click('button[type=submit]');
await p.waitForSelector('table, .empty');
await p.click('nav a:has-text("配置管理")');
await p.waitForSelector('tbody tr .badge.published', { timeout: 15000 });

const baseVersion = await cfgVersion();
ok(`初始生效版本 v${baseVersion}`, baseVersion >= 1);

await p.selectOption('.actions-row select', 'rtp92');
await p.click('button:has-text("从预设新建草稿")');
await p.waitForSelector('.editor', { timeout: 15000 });
ok('草稿创建并打开编辑器', await p.isVisible('.editor'));

await p.locator('.field-row:has-text("白板权重") input').fill('7');
await p.click('button:has-text("保存并估算")');
await p.waitForSelector('.sim-result', { timeout: 120000 });
const simText = await p.textContent('.sim-result');
ok(`估算返回真实 RTP（${simText.match(/RTP [\d.]+%/)?.[0] ?? '?'}）`, /RTP \d/.test(simText));
await p.screenshot({ path: `${DIR}/admin-configs-editor.png` });

await p.click('.editor-ops button:has-text("发布")');
await p.waitForFunction((base) => document.querySelector('tbody tr:first-child .badge.published') != null
  && !document.querySelector('.editor'), baseVersion, { timeout: 15000 });
const afterPublish = await cfgVersion();
ok(`发布生效：版本从 v${baseVersion} → v${afterPublish}`, afterPublish > baseVersion);

const gamePage = await browser.newPage();
await gamePage.goto('http://127.0.0.1:8789/', { waitUntil: 'networkidle' });
await gamePage.waitForTimeout(600);
await gamePage.click('#spin');
await gamePage.waitForFunction(() => !document.querySelector('#spin').disabled, null, { timeout: 60000 });
const spinCfg = await gamePage.evaluate(async () => (await (await fetch('/api/config')).json()).version);
ok(`游戏端已切到新配置 v${spinCfg}`, spinCfg === afterPublish);

await p.click(`tbody tr:has-text("v${baseVersion}") button:has-text("回滚到此")`);
await p.waitForTimeout(1500);
const afterRb = await cfgVersion();
ok(`回滚生效：当前 v${afterRb}（v${baseVersion} 的复制，> 发布版本 v${afterPublish}）`, afterRb > afterPublish);
await p.screenshot({ path: `${DIR}/admin-configs-list.png` });

ok('浏览器无 JS 异常', errors.length === 0);
await browser.close();
console.log(fails.length === 0 ? 'ALL PASS' : `FAILED: ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
