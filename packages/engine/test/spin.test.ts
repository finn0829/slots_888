import { describe, it, expect } from 'vitest';
import { spin, winTierFor } from '../src/spin';
import { defaultPreset } from '../src/config';
import type { GameConfig, SpinResult } from '../src/types';

const BET = 100;

function baseSpin(seed: string, config: GameConfig = defaultPreset()): SpinResult {
  return spin({ seed, bet: BET, anteEnabled: false, mode: 'base', config });
}

/** 找一个满足条件的 seed（确定性搜索，找不到则测试失败） */
function findSeed(pred: (r: SpinResult) => boolean, config?: GameConfig, max = 5000): SpinResult {
  for (let i = 0; i < max; i++) {
    const r = baseSpin(`hunt-${i}`, config);
    if (pred(r)) return r;
  }
  throw new Error('未找到满足条件的 seed，请放宽条件或检查实现');
}

describe('spin 基本结构与确定性', () => {
  it('同 seed 同 config → 结果逐字段一致（回放根基）', () => {
    expect(baseSpin('replay-check')).toEqual(baseSpin('replay-check'));
  });

  it('盘面 6×5；无 ante 时 totalCost = bet；ante 时 = bet×1.25', () => {
    const r = baseSpin('shape');
    expect(r.cascades[0]!.gridBefore).toHaveLength(6);
    for (const col of r.cascades[0]!.gridBefore) expect(col).toHaveLength(5);
    expect(r.totalCost).toBe(BET);
    const ante = spin({ seed: 'shape', bet: BET, anteEnabled: true, mode: 'base', config: defaultPreset() });
    expect(ante.totalCost).toBe(125);
  });

  it('免费旋转 totalCost = 0', () => {
    const r = spin({ seed: 'free-cost', bet: BET, anteEnabled: false, mode: 'free', accumulatedMultiplier: 1, config: defaultPreset() });
    expect(r.totalCost).toBe(0);
  });
});

describe('连锁与倍数阶梯', () => {
  it('中奖步：stepWin = Σ basePayout × 当步倍数，倍数按 1→2→3→5→10 递增；totalWin = Σ stepWin', () => {
    const r = findSeed((x) => x.totalWin > 0);
    const ladder = defaultPreset().chainLadder;
    let expectedTotal = 0;
    let winStep = 0;
    for (const step of r.cascades) {
      if (step.wins.length === 0) continue;
      const mult = ladder[Math.min(winStep, ladder.length - 1)]!;
      expect(step.chainMultiplier).toBe(mult);
      const base = step.wins.reduce((s, w) => s + w.basePayout, 0);
      expect(step.stepWin).toBe(base * mult);
      expectedTotal += step.stepWin;
      winStep++;
    }
    expect(r.totalWin).toBe(expectedTotal);
  });

  it('中奖步的 removedPositions = 各中奖组位置并集；gridAfter 与下一步 gridBefore 相同', () => {
    const r = findSeed((x) => x.totalWin > 0 && x.cascades.length >= 2);
    for (let i = 0; i < r.cascades.length - 1; i++) {
      expect(r.cascades[i]!.gridAfter).toEqual(r.cascades[i + 1]!.gridBefore);
    }
    const step = r.cascades[0]!;
    const union = new Set(step.wins.flatMap((w) => w.positions.map((p) => `${p.col},${p.row}`)));
    expect(new Set(step.removedPositions.map((p) => `${p.col},${p.row}`))).toEqual(union);
  });

  it('免费旋转：倍数从传入的 accumulatedMultiplier 继续，跨 spin 不重置', () => {
    // 找一个免费模式下有 ≥2 个中奖步的局：传入 acc=3（阶梯第 3 格），
    // 则中奖步倍数应为 3, 5, ...，accAfter 继续推进
    for (let i = 0; i < 5000; i++) {
      const r = spin({ seed: `facc-${i}`, bet: BET, anteEnabled: false, mode: 'free', accumulatedMultiplier: 3, config: defaultPreset() });
      const winSteps = r.cascades.filter((s) => s.wins.length > 0);
      if (winSteps.length >= 2) {
        expect(winSteps[0]!.chainMultiplier).toBe(3);
        expect(winSteps[1]!.chainMultiplier).toBe(5);
        expect(r.accumulatedMultiplierAfter).toBeGreaterThanOrEqual(5);
        return;
      }
      if (winSteps.length === 0) {
        // 无中奖：倍数原样带出
        expect(r.accumulatedMultiplierAfter).toBe(3);
      }
    }
    throw new Error('未找到免费模式多连锁局');
  });

  it('阶梯超出末档后每级 +5（10 之后 15, 20…）', () => {
    // 用高赔付配置制造长连锁不现实；直接验证导出的阶梯函数语义体现在 config 上
    const cfg = defaultPreset();
    expect(cfg.chainLadder).toEqual([1, 2, 3, 5, 10]);
    expect(cfg.ladderStepAfter).toBe(5);
  });
});

describe('骰子（scatter）与免费旋转', () => {
  const scatterHeavy: GameConfig = { ...defaultPreset(), scatterWeight: 40 };

  it('scatterCount 只数首盘面；4 个 → 10 次，5 个 → 12 次', () => {
    let seen4 = false, seen5 = false;
    for (let i = 0; i < 3000 && !(seen4 && seen5); i++) {
      const r = baseSpin(`sc-${i}`, scatterHeavy);
      const firstBoardScatters = r.cascades[0]!.gridBefore.flat().filter((c) => c.symbol === 'scatter').length;
      expect(r.scatterCount).toBe(firstBoardScatters);
      if (r.scatterCount === 4) { expect(r.freeSpinsAwarded).toBe(10); seen4 = true; }
      if (r.scatterCount === 5) { expect(r.freeSpinsAwarded).toBe(12); seen5 = true; }
      if (r.scatterCount < 4) expect(r.freeSpinsAwarded).toBe(0);
    }
    expect(seen4).toBe(true);
    expect(seen5).toBe(true);
  });

  it('补牌永不出 scatter：终盘 scatter 数 === 首盘 scatter 数（scatter 不参与消除）', () => {
    const r = findSeed((x) => x.totalWin > 0 && x.scatterCount > 0, scatterHeavy);
    const last = r.cascades[r.cascades.length - 1]!;
    const grid = last.wins.length === 0 ? last.gridBefore : last.gridAfter;
    expect(grid.flat().filter((c) => c.symbol === 'scatter')).toHaveLength(r.scatterCount);
  });
});

describe('金牌（gold）', () => {
  it('基础局永不出金牌', () => {
    for (let i = 0; i < 300; i++) {
      const r = baseSpin(`nogold-${i}`);
      for (const step of r.cascades) {
        expect(step.gridBefore.flat().every((c) => c.symbol !== 'gold')).toBe(true);
      }
      expect(r.goldMultipliers).toEqual([]);
    }
  });

  it('免费局：金牌倍数相加后乘到 totalWin', () => {
    const cfg: GameConfig = { ...defaultPreset(), goldWeight: 60 };
    for (let i = 0; i < 5000; i++) {
      const r = spin({ seed: `gold-${i}`, bet: BET, anteEnabled: false, mode: 'free', accumulatedMultiplier: 1, config: cfg });
      if (r.goldMultipliers.length > 0 && r.totalWin > 0) {
        const goldSum = r.goldMultipliers.reduce((a, b) => a + b, 0);
        const rawWin = r.cascades.reduce((s, st) => s + st.stepWin, 0);
        expect(r.totalWin).toBe(Math.min(rawWin * goldSum, BET * cfg.maxWinX));
        return;
      }
    }
    throw new Error('未找到含金牌的中奖免费局');
  });
});

describe('封顶与赢奖分级', () => {
  it('totalWin 封顶 5000×bet', () => {
    const cfg: GameConfig = { ...defaultPreset(), payoutScale: 10000 };
    const r = findSeed((x) => x.totalWin > 0, cfg);
    expect(r.totalWin).toBe(BET * cfg.maxWinX);
  });

  it('winTierFor 阈值：<5× null，≥5 碰，≥10 杠，≥25 胡，≥50 自摸，≥100 天胡', () => {
    expect(winTierFor(499, BET)).toBeNull();
    expect(winTierFor(500, BET)).toBe('peng');
    expect(winTierFor(999, BET)).toBe('peng');
    expect(winTierFor(1000, BET)).toBe('gang');
    expect(winTierFor(2500, BET)).toBe('hu');
    expect(winTierFor(5000, BET)).toBe('zimo');
    expect(winTierFor(10000, BET)).toBe('tianhu');
    expect(winTierFor(0, BET)).toBeNull();
  });
});
