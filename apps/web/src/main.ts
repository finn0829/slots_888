import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css';
import './style.css';
import type { SpinResult, WinTier } from '@slots/engine';
import { Board } from './board';
import { Fx, shake } from './fx';
import { Sound } from './sound';
import { claimDaily, claimRelief, ensureSession, fetchConfig, fetchStats, requestSpin, type PlayerState, type PublicConfig } from './api';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const TIER_TEXT: Record<WinTier, string> = {
  peng: '碰！', gang: '杠！', hu: '胡了！', zimo: '自摸！', tianhu: '天　胡',
};
const TIER_RAIN: Record<WinTier, number> = { peng: 0, gang: 0, hu: 1, zimo: 2, tianhu: 3 };

let state: PlayerState;
let config: PublicConfig;
let betIndex = 3; // 默认 100
let spinning = false;

// 自动旋转
const AUTO_COUNTS = [10, 25, 50, 100];
let autoRemaining = 0;
let autoStopOnFeature = true;
let autoStopOnBigWin = false;

// Ante Bet：注 ×1.25 换更高的免费旋转触发率
let anteEnabled = localStorage.getItem('slots888_ante') === '1';

const board = new Board($('board') as unknown as HTMLCanvasElement);
const fx = new Fx($('fx') as unknown as HTMLCanvasElement);
const sound = new Sound();
board.onColumnLand = () => sound.land();

function fmt(n: number) { return Math.round(n).toLocaleString('zh-CN'); }

/** 金额滚动计数（ease-out） */
const rolling = new Map<HTMLElement, number>();
function rollTo(el: HTMLElement, to: number, ms = 500) {
  const from = rolling.get(el) ?? (Number(el.textContent?.replace(/,/g, '')) || 0);
  rolling.set(el, to);
  if (from === to || board.reducedMotion) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const dur = ms / board.speed;
  const tick = (now: number) => {
    if (rolling.get(el) !== to) return; // 有更新的目标接管了
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 一次 spin 的实际扣款（ante 时为注 ×1.25） */
function spinCost(): number {
  const bet = config.betLevels[betIndex]!;
  return anteEnabled ? Math.round(bet * config.anteRule.costMultiplier) : bet;
}

function renderAnte() {
  const { costMultiplier, triggerRate, anteTriggerRate, speedup } = config.anteRule;
  const bet = config.betLevels[betIndex]!;
  const rate = (r: number) => `1/${Math.round(1 / r)}`;

  $('ante').classList.toggle('on', anteEnabled);
  ($('ante-check') as HTMLInputElement).checked = anteEnabled;
  $('ante-cost').textContent = `${fmt(Math.round(bet * costMultiplier))} 文`;
  $('ante-speed').textContent = `${speedup.toFixed(2)}×`;
  $('ante-detail').textContent = `免费旋转触发：${rate(triggerRate)} → ${rate(anteTriggerRate)}`;

  // 扣款提示（开启时在下注区显示真实花费）
  const costEl = $('bet-cost');
  costEl.style.display = anteEnabled ? 'block' : 'none';
  costEl.textContent = `实扣 ${fmt(spinCost())}`;
}

function renderHud() {
  rollTo($('balance'), state.balance, 400);
  $('bet').textContent = String(config.betLevels[betIndex]);
  const fs = state.freeSpinsRemaining;
  const fsEl = $('freespins');
  fsEl.style.display = fs > 0 ? 'flex' : 'none';
  $('freespins-count').textContent = String(fs);
  $('freespins-mult').textContent = `×${state.accumulatedMultiplier || 1}`;
  const pct = Math.min(100, (state.diceProgress / config.pity.target) * 100);
  $('dice-fill').style.width = `${pct}%`;
  $('dice-label').textContent = `🎲 ${state.diceProgress}/${config.pity.target}`;
  const inFree = fs > 0;
  const auto = autoRemaining > 0;
  ($('bet-minus') as HTMLButtonElement).disabled = spinning || inFree || auto;
  ($('bet-plus') as HTMLButtonElement).disabled = spinning || inFree || auto;
  ($('spin') as HTMLButtonElement).disabled = spinning || auto;
  // 免费旋转期间 ante 不生效（服务端强制忽略），UI 同步禁用
  ($('ante') as HTMLButtonElement).disabled = spinning || inFree || auto;
  renderAnte();

  // 自动旋转：转起来后按钮变「停止 (剩余次数)」
  const autoBtn = $('auto') as HTMLButtonElement;
  autoBtn.textContent = auto ? `停 ${autoRemaining}` : '自动';
  autoBtn.classList.toggle('on', auto);
  autoBtn.disabled = inFree;

  // 经济按钮：仅在可领时出现
  const claimEl = $('claim');
  const canDaily = state.canClaimDaily;
  const canRelief = state.canClaimRelief;
  claimEl.style.display = (canDaily || canRelief) && !auto ? 'flex' : 'none';
  ($('claim-daily') as HTMLButtonElement).style.display = canDaily ? 'block' : 'none';
  ($('claim-relief') as HTMLButtonElement).style.display = canRelief ? 'block' : 'none';

  // 空闲吸引：余额够、没在转时 spin 键呼吸
  $('spin').classList.toggle('attract', !spinning && !auto && !inFree && state.balance >= spinCost());
}

function showBanner(text: string, sub: string, tier: WinTier | 'fs' | 'info'): Promise<void> {
  return new Promise((resolve) => {
    const el = $('banner');
    $('banner-text').textContent = text;
    $('banner-sub').textContent = sub;
    const big = tier === 'fs' || tier === 'hu' || tier === 'zimo' || tier === 'tianhu';
    el.className = `banner show tier-${tier}${big ? ' big' : ''}`;
    const done = () => { el.className = 'banner'; el.onclick = null; resolve(); };
    el.onclick = done;
    setTimeout(done, (big ? 2300 : 1100) / board.speed);
  });
}

/** 连锁倍数大字弹出 */
function popMultiplier(mult: number) {
  if (mult < 2) return;
  const el = $('mult-pop');
  el.textContent = `×${mult}`;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

async function playResult(result: SpinResult) {
  await board.dropIn(result.cascades[0]!.gridBefore);

  let running = 0;
  for (const step of result.cascades) {
    if (step.wins.length === 0) break;
    popMultiplier(step.chainMultiplier);
    if (step.chainMultiplier >= 2) sound.pop(step.chainMultiplier);
    await board.flashWins(step.removedPositions);
    sound.remove();
    await board.removeTiles(step.removedPositions);
    running += step.stepWin;
    rollTo($('win'), running, 420);
    await board.applyAfter(step.gridAfter, step.removedPositions);
  }

  if (result.goldMultipliers.length > 0 && result.totalWin > 0) {
    const sum = result.goldMultipliers.reduce((a, b) => a + b, 0);
    await showBanner(`金牌 ×${sum}`, `${fmt(running)} → ${fmt(result.totalWin)}`, 'info');
  }
  rollTo($('win'), result.totalWin, 500);

  if (result.winTier) {
    const rain = TIER_RAIN[result.winTier];
    if (rain > 0) fx.rain(rain);
    if (result.winTier === 'tianhu') shake($('app'));
    sound.tier(result.winTier);
    await showBanner(TIER_TEXT[result.winTier], `赢 ${fmt(result.totalWin)} 文`, result.winTier);
  }
  if (result.freeSpinsAwarded > 0) {
    fx.rain(2);
    sound.gong();
    await showBanner('免费旋转！', `骰子 ×${result.scatterCount} → ${result.freeSpinsAwarded} 次`, 'fs');
  }
}

function stopAuto() {
  autoRemaining = 0;
  renderHud();
}

async function doSpin() {
  if (spinning) return;
  spinning = true;
  rolling.set($('win'), 0);
  $('win').textContent = '0';
  renderHud();
  let next: 'free' | 'auto' | null = null;
  try {
    const bet = config.betLevels[betIndex]!;
    const res = await requestSpin(bet, anteEnabled);
    // 演出期间先显示扣注后的余额，赢奖随连锁滚动
    rollTo($('balance'), res.state.balance - res.spin.totalWin, 250);
    await playResult(res.spin);
    state = res.state;

    // 自动旋转的停止条件（免费旋转期间不消耗自动次数）
    if (autoRemaining > 0 && res.spin.mode === 'base') {
      autoRemaining--;
      const tier = res.spin.winTier;
      const bigWin = tier === 'hu' || tier === 'zimo' || tier === 'tianhu';
      if (res.spin.freeSpinsAwarded > 0 && autoStopOnFeature) autoRemaining = 0;
      else if (bigWin && autoStopOnBigWin) autoRemaining = 0;
      else if (state.balance < spinCost()) autoRemaining = 0; // 余额不够（按 ante 后的实扣算），自动停
    }
    renderHud();

    if (state.freeSpinsRemaining > 0) next = 'free';
    else if (autoRemaining > 0) next = 'auto';
  } catch (err) {
    autoRemaining = 0;
    const e = err as Error & { status?: number };
    if (e.status === 402) {
      await showBanner('余额不足', state.canClaimRelief ? '点「补给」领救济金' : '明日签到可补币', 'info');
    } else {
      await showBanner('出错了', e.message, 'info');
    }
  } finally {
    spinning = false;
    renderHud();
  }
  if (next) setTimeout(() => void doSpin(), (next === 'free' ? 550 : 350) / board.speed);
}

/** 领取签到/救济 */
async function doClaim(kind: 'daily' | 'relief') {
  if (spinning) return;
  try {
    const res = kind === 'daily' ? await claimDaily() : await claimRelief();
    state = res.state;
    sound.gong();
    await showBanner(kind === 'daily' ? '每日签到' : '救济金', `+${fmt(res.amount)} 文`, 'info');
  } catch (err) {
    await showBanner('领取失败', (err as Error).message, 'info');
  } finally {
    renderHud();
  }
}

/** 桌面侧栏赔付表（按当前注换算成文） */
const PT_SYMBOLS: Array<{ key: string; char: string; cls: string }> = [
  { key: 'zhong', char: '中', cls: 'red' },
  { key: 'fa', char: '發', cls: 'green' },
  { key: 'east', char: '東', cls: 'blue' },
  { key: 'south', char: '南', cls: 'blue' },
  { key: 'west', char: '西', cls: 'blue' },
  { key: 'north', char: '北', cls: 'blue' },
  { key: 'wan', char: '萬', cls: 'red' },
  { key: 'tong', char: '筒', cls: 'blue' },
  { key: 'tiao', char: '條', cls: 'green' },
];
function paytableRows(bet: number) {
  const head = `<div class="pt-row pt-head"><b></b><span>8+</span><span>10+</span><span>12+</span></div>`;
  const rows = PT_SYMBOLS.map(({ key, char, cls }) => {
    const pays = config.paytable[key] ?? [0, 0, 0];
    const cells = pays.map((p) => `<span>${fmt(p * bet)}</span>`).join('');
    return `<div class="pt-row"><b class="pt-sym ${cls}">${char}</b>${cells}</div>`;
  }).join('');
  return head + rows;
}

function renderPaytable() {
  const bet = config.betLevels[betIndex]!;
  $('paytable').innerHTML = `
    <h3>赔付表 <small>注 ${bet}</small></h3>
    ${paytableRows(bet)}
    <p class="pt-note">白板＝百搭 · 骰子 ≥${config.freeSpins.trigger} 触发免费旋转<br>集满 ${config.pity.target} 骰子必得 ${config.pity.award} 次 · 封顶 ${fmt(config.maxWinX * bet)}</p>`;
}

/** 游戏内规则页（手机端唯一能看到赔付表的地方） */
function renderRules() {
  const bet = config.betLevels[betIndex]!;
  $('rules-body').innerHTML = `
    <section>
      <h4>怎么赢</h4>
      <p>全盘 30 张牌，<b>同一种牌出现 8 张以上即中奖</b>，不看位置。中奖的牌会被「打出去」，上方的牌落下补位——可能再次凑成中奖，形成<b>连锁</b>。</p>
    </section>
    <section>
      <h4>赔付表 <small>按当前注 ${bet} 文换算</small></h4>
      <div class="rules-pt">${paytableRows(bet)}</div>
    </section>
    <section>
      <h4>连锁倍数</h4>
      <p>同一局里每连锁一次，倍数递增：<b>×1 → ×2 → ×3 → ×5 → ×10</b>。免费旋转期间倍数<b>整局累加、不重置</b>——这是所有大奖的来源。</p>
    </section>
    <section>
      <h4>特殊牌</h4>
      <p><b class="pt-sym gold">百搭</b>（白板）替代任意普通牌凑数，一张可同时算进多个中奖组。</p>
      <p><b>🎲 骰子</b>散落任意位置，出现 ≥${config.freeSpins.trigger} 个触发<b>免费旋转 ${config.freeSpins.base} 次</b>（每多 1 个 +${config.freeSpins.perExtra} 次）。</p>
      <p><b>金牌</b>只在免费旋转出现，牌面倍数<b>相加</b>后乘到该次总赢奖。</p>
    </section>
    <section>
      <h4>骰子收集（保底）</h4>
      <p>每出现 1 个骰子，进度条 +1（不足 ${config.freeSpins.trigger} 个也算）。<b>集满 ${config.pity.target} 必得 ${config.pity.award} 次免费旋转</b>，然后清零。连败不是白输，是可见的积累。</p>
    </section>
    <section>
      <h4>赢奖分级</h4>
      <p>碰 ≥5× · 杠 ≥10× · 胡了 ≥25× · 自摸 ≥50× · 天胡 ≥100×。单局封顶 <b>${config.maxWinX}×</b>（当前注 = ${fmt(config.maxWinX * bet)} 文）。</p>
    </section>
    <section>
      <h4>加注（Ante Bet）</h4>
      <p>开启后每局多付 <b>${Math.round((config.anteRule.costMultiplier - 1) * 100)}%</b>（当前注 ${bet} → 实扣 <b>${fmt(Math.round(bet * config.anteRule.costMultiplier))}</b> 文），换取<b>更高的骰子出现率</b>：</p>
      <p>免费旋转触发 <b>1/${Math.round(1 / config.anteRule.triggerRate)}</b> → <b>1/${Math.round(1 / config.anteRule.anteTriggerRate)}</b>，快 <b>${config.anteRule.speedup.toFixed(2)} 倍</b>。</p>
      <p class="dim">这是唯一影响概率的开关，且完全由你掌控。以上数字由服务端按当前生效配置实时计算，不是宣传话术。</p>
    </section>
    <section class="rules-rtp">
      <h4>公平性</h4>
      <p>本游戏 <b>RTP（返奖率）约 95.6%</b>，由服务端权威判定，每一局的随机种子与结果全量留档、可审计回放。<b>不存在连败后暗中调整概率的机制</b>。</p>
      <p class="dim">虚拟币娱乐，不涉及真实货币。</p>
    </section>`;
}

function toggleRules(show: boolean) {
  if (show) renderRules();
  $('rules').classList.toggle('show', show);
}

/** 个人战绩（WEB-13）：诚实展示投入与回报，玩家可自行验证公示的 RTP */
async function toggleStats(show: boolean) {
  const el = $('stats');
  if (!show) { el.classList.remove('show'); return; }
  $('stats-body').innerHTML = '<p class="dim">统计中…</p>';
  el.classList.add('show');
  try {
    const s = await fetchStats();
    const netCls = s.net > 0 ? 'up' : s.net < 0 ? 'down' : '';
    const sign = s.net > 0 ? '+' : '';
    const rtpTxt = s.rtp === null ? '—' : `${(s.rtp * 100).toFixed(1)}%`;
    const rtpNote = s.totalSpins < 200
      ? `样本仅 ${s.totalSpins} 局，波动很大——转够 1000 局以上才会向 95.6% 收敛。`
      : `理论值 95.6%。你的实测偏差属正常波动，样本越大越接近。`;

    $('stats-body').innerHTML = `
      <div class="stats-hero ${netCls}">
        <span class="label">净额</span>
        <b>${sign}${fmt(s.net)}</b>
        <span class="unit">文</span>
      </div>
      <div class="stats-grid">
        <div><span>总投入</span><b>${fmt(s.totalBet)}</b></div>
        <div><span>总赢奖</span><b class="gold">${fmt(s.totalWin)}</b></div>
        <div><span>总局数</span><b>${fmt(s.totalSpins)}</b></div>
        <div><span>命中率</span><b>${s.hitRate === null ? '—' : `${(s.hitRate * 100).toFixed(1)}%`}</b></div>
        <div><span>最大单局</span><b class="gold">${fmt(s.biggestWin)}</b></div>
        <div><span>最高倍数</span><b class="gold">${s.biggestWinX.toFixed(1)}×</b></div>
        <div><span>免费旋转</span><b>${fmt(s.freeSpinsPlayed)} 局</b></div>
        <div><span>领取补贴</span><b>${fmt(s.bonusReceived)}</b></div>
      </div>
      <div class="stats-rtp">
        <div class="stats-rtp-head">
          <span>你的实测返奖率</span>
          <b>${rtpTxt}</b>
        </div>
        <p class="dim">${rtpNote}</p>
        <p class="dim">总赢奖 ÷ 总投入。免费旋转不计入投入，签到与救济金不计入赢奖。</p>
      </div>`;
  } catch (err) {
    $('stats-body').innerHTML = `<p class="dim">读取失败：${(err as Error).message}</p>`;
  }
}

function demoGrid() {
  const symbols = ['zhong', 'fa', 'east', 'south', 'west', 'north', 'wan', 'tong', 'tiao'] as const;
  return Array.from({ length: 6 }, () =>
    Array.from({ length: 5 }, () => ({ symbol: symbols[Math.floor(Math.random() * symbols.length)]! })),
  );
}

async function init() {
  board.resize();
  window.addEventListener('resize', () => board.resize());
  board.setGrid(demoGrid());

  // 等书法字体就绪再重绘牌面（牌面字是这个游戏的脸）
  const glyphs = '中發東南西北萬筒條百搭碰杠胡了自摸天免费旋转金牌雀开局×0123456789';
  void Promise.race([
    document.fonts.load('700 48px "LXGW WenKai"', glyphs),
    new Promise((r) => setTimeout(r, 3500)),
  ]).then(() => { board.refreshAtlas(); });

  config = await fetchConfig();
  state = await ensureSession();
  renderHud();
  renderPaytable();

  $('bet-minus').onclick = () => { if (betIndex > 0) { betIndex--; renderHud(); renderPaytable(); } };
  $('bet-plus').onclick = () => { if (betIndex < config.betLevels.length - 1) { betIndex++; renderHud(); renderPaytable(); } };

  // Ante Bet 开关
  $('ante').onclick = () => {
    anteEnabled = !anteEnabled;
    localStorage.setItem('slots888_ante', anteEnabled ? '1' : '0');
    if (anteEnabled) sound.pop(2);
    renderHud();
  };
  $('spin').onclick = () => void doSpin();
  $('turbo').onclick = () => {
    board.speed = board.speed === 1 ? 2.5 : 1;
    $('turbo').classList.toggle('on', board.speed !== 1);
  };
  $('mute').onclick = () => {
    const muted = sound.toggle();
    $('mute').textContent = muted ? '静' : '音';
    $('mute').classList.toggle('off', muted);
  };
  $('mute').textContent = sound.muted ? '静' : '音';
  $('mute').classList.toggle('off', sound.muted);

  // 自动旋转：未开启时点开面板选次数；已开启时点击立即停止
  $('auto').onclick = () => {
    if (autoRemaining > 0) { stopAuto(); return; }
    $('auto-panel').classList.toggle('show');
  };
  $('auto-counts').innerHTML = AUTO_COUNTS
    .map((n) => `<button data-n="${n}">${n} 次</button>`).join('');
  $('auto-counts').onclick = (e) => {
    const n = Number((e.target as HTMLElement).dataset.n);
    if (!n) return;
    $('auto-panel').classList.remove('show');
    autoRemaining = n;
    renderHud();
    void doSpin();
  };
  ($('auto-stop-feature') as HTMLInputElement).checked = autoStopOnFeature;
  ($('auto-stop-feature') as HTMLInputElement).onchange = (e) => {
    autoStopOnFeature = (e.target as HTMLInputElement).checked;
  };
  ($('auto-stop-bigwin') as HTMLInputElement).checked = autoStopOnBigWin;
  ($('auto-stop-bigwin') as HTMLInputElement).onchange = (e) => {
    autoStopOnBigWin = (e.target as HTMLInputElement).checked;
  };

  // 规则页
  $('info').onclick = () => toggleRules(true);
  $('rules-close').onclick = () => toggleRules(false);
  $('rules').onclick = (e) => { if (e.target === $('rules')) toggleRules(false); };

  // 个人战绩
  $('stats-btn').onclick = () => void toggleStats(true);
  $('stats-close').onclick = () => void toggleStats(false);
  $('stats').onclick = (e) => { if (e.target === $('stats')) void toggleStats(false); };

  // 经济按钮
  $('claim-daily').onclick = () => void doClaim('daily');
  $('claim-relief').onclick = () => void doClaim('relief');

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      toggleRules(false);
      void toggleStats(false);
      $('auto-panel').classList.remove('show');
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (autoRemaining > 0) stopAuto();
      else void doSpin();
    }
  });
}

void init();
