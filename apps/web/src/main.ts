import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css';
import './style.css';
import type { SpinResult, WinTier } from '@slots/engine';
import { Board } from './board';
import { Fx, shake } from './fx';
import { Sound } from './sound';
import { ensureSession, fetchConfig, requestSpin, type PlayerState, type PublicConfig } from './api';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const TIER_TEXT: Record<WinTier, string> = {
  peng: '碰！', gang: '杠！', hu: '胡了！', zimo: '自摸！', tianhu: '天　胡',
};
const TIER_RAIN: Record<WinTier, number> = { peng: 0, gang: 0, hu: 1, zimo: 2, tianhu: 3 };

let state: PlayerState;
let config: PublicConfig;
let betIndex = 3; // 默认 100
let spinning = false;

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
  ($('bet-minus') as HTMLButtonElement).disabled = spinning || inFree;
  ($('bet-plus') as HTMLButtonElement).disabled = spinning || inFree;
  ($('spin') as HTMLButtonElement).disabled = spinning;
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

async function doSpin() {
  if (spinning) return;
  spinning = true;
  rolling.set($('win'), 0);
  $('win').textContent = '0';
  renderHud();
  try {
    const bet = config.betLevels[betIndex]!;
    const res = await requestSpin(bet);
    // 演出期间先显示扣注后的余额，赢奖随连锁滚动
    rollTo($('balance'), res.state.balance - res.spin.totalWin, 250);
    await playResult(res.spin);
    state = res.state;
    renderHud();
    if (state.freeSpinsRemaining > 0) {
      spinning = false;
      setTimeout(() => void doSpin(), 550 / board.speed);
      return;
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 402) {
      await showBanner('余额不足', '明日签到可补币（后续开放）', 'info');
    } else {
      await showBanner('出错了', e.message, 'info');
    }
  } finally {
    spinning = false;
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
function renderPaytable() {
  const bet = config.betLevels[betIndex]!;
  const rows = PT_SYMBOLS.map(({ key, char, cls }) => {
    const pays = config.paytable[key] ?? [0, 0, 0];
    const cells = pays.map((p) => `<span>${fmt(p * bet)}</span>`).join('');
    return `<div class="pt-row"><b class="pt-sym ${cls}">${char}</b>${cells}</div>`;
  }).join('');
  $('paytable').innerHTML = `
    <h3>赔付表 <small>注 ${bet}</small></h3>
    <div class="pt-row pt-head"><b></b><span>8+</span><span>10+</span><span>12+</span></div>
    ${rows}
    <p class="pt-note">白板＝百搭 · 骰子 ≥${config.freeSpins.trigger} 触发免费旋转<br>集满 ${config.pity.target} 骰子必得 ${config.pity.award} 次 · 封顶 ${fmt(config.maxWinX * bet)}</p>`;
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
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); void doSpin(); }
  });
}

void init();
