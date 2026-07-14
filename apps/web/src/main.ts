import './style.css';
import type { SpinResult, WinTier } from '@slots/engine';
import { Board } from './board';
import { ensureSession, fetchConfig, requestSpin, type PlayerState, type PublicConfig } from './api';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const TIER_TEXT: Record<WinTier, string> = {
  peng: '碰！', gang: '杠！', hu: '胡了！', zimo: '自摸！', tianhu: '天　胡',
};

let state: PlayerState;
let config: PublicConfig;
let betIndex = 3; // 默认 100
let spinning = false;

const board = new Board($('board') as unknown as HTMLCanvasElement);

function fmt(n: number) { return n.toLocaleString('zh-CN'); }

function renderHud() {
  $('balance').textContent = fmt(state.balance);
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

function showBanner(text: string, sub: string, big: boolean): Promise<void> {
  return new Promise((resolve) => {
    const el = $('banner');
    $('banner-text').textContent = text;
    $('banner-sub').textContent = sub;
    el.className = big ? 'banner show big' : 'banner show';
    const done = () => { el.className = 'banner'; el.onclick = null; resolve(); };
    el.onclick = done;
    setTimeout(done, (big ? 2200 : 1100) / board.speed);
  });
}

async function playResult(result: SpinResult) {
  const chainEl = $('chain');
  await board.dropIn(result.cascades[0]!.gridBefore);

  let running = 0;
  for (const step of result.cascades) {
    if (step.wins.length === 0) break;
    chainEl.textContent = `连锁 ×${step.chainMultiplier}`;
    chainEl.classList.add('show');
    await board.flashWins(step.removedPositions);
    await board.removeTiles(step.removedPositions);
    running += step.stepWin;
    $('win').textContent = fmt(running);
    await board.applyAfter(step.gridAfter, step.removedPositions);
  }
  chainEl.classList.remove('show');

  if (result.goldMultipliers.length > 0 && result.totalWin > 0) {
    const sum = result.goldMultipliers.reduce((a, b) => a + b, 0);
    await showBanner(`金牌 ×${sum}`, `${fmt(running)} → ${fmt(result.totalWin)}`, false);
  }
  $('win').textContent = fmt(result.totalWin);

  if (result.winTier) {
    await showBanner(TIER_TEXT[result.winTier], `赢 ${fmt(result.totalWin)} 文`, result.winTier !== 'peng');
  }
  if (result.freeSpinsAwarded > 0) {
    await showBanner('免费旋转！', `骰子 ×${result.scatterCount} → ${result.freeSpinsAwarded} 次`, true);
  }
}

async function doSpin() {
  if (spinning) return;
  spinning = true;
  $('win').textContent = '0';
  renderHud();
  try {
    const bet = config.betLevels[betIndex]!;
    const res = await requestSpin(bet);
    // 演出期间先显示扣注后的余额，赢奖随连锁滚动
    $('balance').textContent = fmt(res.state.balance - res.spin.totalWin);
    await playResult(res.spin);
    state = res.state;
    renderHud();
    // 免费旋转自动续转
    if (state.freeSpinsRemaining > 0) {
      spinning = false;
      setTimeout(() => void doSpin(), 600 / board.speed);
      return;
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 402) {
      await showBanner('余额不足', '明日签到可补币（V1 后续开放）', false);
    } else {
      await showBanner('出错了', e.message, false);
    }
  } finally {
    spinning = false;
    renderHud();
  }
}

async function init() {
  board.resize();
  window.addEventListener('resize', () => board.resize());

  config = await fetchConfig();
  state = await ensureSession();
  renderHud();

  $('bet-minus').onclick = () => { if (betIndex > 0) { betIndex--; renderHud(); } };
  $('bet-plus').onclick = () => { if (betIndex < config.betLevels.length - 1) { betIndex++; renderHud(); } };
  $('spin').onclick = () => void doSpin();
  $('turbo').onclick = () => {
    board.speed = board.speed === 1 ? 2.5 : 1;
    $('turbo').classList.toggle('on', board.speed !== 1);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); void doSpin(); }
  });

  // 开屏铺一盘静态牌
  const demo = await requestDemoGrid();
  if (demo) board.setGrid(demo);
}

/** 开屏无需消耗真实 spin：本地随便铺一盘（仅视觉） */
async function requestDemoGrid() {
  const symbols = ['zhong', 'fa', 'east', 'south', 'west', 'north', 'wan', 'tong', 'tiao'] as const;
  return Array.from({ length: 6 }, () =>
    Array.from({ length: 5 }, () => ({ symbol: symbols[Math.floor(Math.random() * symbols.length)]! })),
  );
}

void init();
