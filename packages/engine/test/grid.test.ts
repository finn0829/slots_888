import { describe, it, expect } from 'vitest';
import { findWins, removeAndDrop } from '../src/grid';
import { defaultPreset } from '../src/config';
import type { Cell, Grid, SymbolId } from '../src/types';

const cfg = defaultPreset();
const BET = 100;

/** 按行书写盘面（5 行 × 6 列，直观），转为 grid[col][row] */
function g(rows: SymbolId[][]): Grid {
  const grid: Grid = [];
  for (let col = 0; col < 6; col++) {
    const column: Cell[] = [];
    for (let row = 0; row < 5; row++) column.push({ symbol: rows[row]![col]! });
    grid.push(column);
  }
  return grid;
}

// 基底盘面：9 种普通牌错开铺，保证无任何 ≥8
const NO_WIN: SymbolId[][] = [
  ['zhong', 'fa', 'east', 'south', 'west', 'north'],
  ['wan', 'tong', 'tiao', 'zhong', 'fa', 'east'],
  ['south', 'west', 'north', 'wan', 'tong', 'tiao'],
  ['zhong', 'fa', 'east', 'south', 'west', 'north'],
  ['wan', 'tong', 'tiao', 'zhong', 'fa', 'east'],
];

function withCells(base: SymbolId[][], marks: Array<[row: number, col: number, sym: SymbolId]>): SymbolId[][] {
  const rows = base.map((r) => [...r]);
  for (const [r, c, s] of marks) rows[r]![c] = s;
  return rows;
}

describe('findWins（全盘计数 ≥8）', () => {
  it('无 ≥8 的盘面 → 无中奖', () => {
    expect(findWins(g(NO_WIN), cfg, BET)).toEqual([]);
  });

  it('恰好 8 个同牌 → 一个中奖组，tier 8，位置齐全', () => {
    // 在 NO_WIN 上把 8 格改成 tong（原有 3 个 tong，先全部抹掉再放 8 个）
    const rows = NO_WIN.map((r) => r.map((s): SymbolId => (s === 'tong' ? 'zhong' : s)));
    const marks: Array<[number, number, SymbolId]> = [
      [0, 0, 'tong'], [0, 1, 'tong'], [1, 1, 'tong'], [2, 2, 'tong'],
      [3, 3, 'tong'], [4, 4, 'tong'], [4, 5, 'tong'], [2, 0, 'tong'],
    ];
    const wins = findWins(g(withCells(rows as SymbolId[][], marks)), cfg, BET);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.symbol).toBe('tong');
    expect(wins[0]!.count).toBe(8);
    expect(wins[0]!.tier).toBe(8);
    expect(wins[0]!.positions).toHaveLength(8);
    expect(wins[0]!.basePayout).toBe(Math.round(BET * cfg.symbols.tong.pay[0] * cfg.payoutScale));
  });

  it('7 个同牌 + 1 wild → 凑成 8，wild 位置计入', () => {
    const rows = NO_WIN.map((r) => r.map((s): SymbolId => (s === 'tong' ? 'zhong' : s)));
    const marks: Array<[number, number, SymbolId]> = [
      [0, 0, 'tong'], [0, 1, 'tong'], [1, 1, 'tong'], [2, 2, 'tong'],
      [3, 3, 'tong'], [4, 4, 'tong'], [4, 5, 'tong'],
      [2, 5, 'wild'],
    ];
    const wins = findWins(g(withCells(rows as SymbolId[][], marks)), cfg, BET);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.count).toBe(8);
    expect(wins[0]!.positions).toContainEqual({ col: 5, row: 2 });
  });

  it('一个 wild 同时计入多个中奖组', () => {
    // tong ×7 + wan ×7 + 1 wild → 两组各 8
    const rows: SymbolId[][] = [
      ['tong', 'tong', 'tong', 'wan', 'wan', 'wan'],
      ['tong', 'tong', 'tong', 'wan', 'wan', 'wan'],
      ['tong', 'zhong', 'wild', 'zhong', 'wan', 'fa'],
      ['east', 'south', 'west', 'north', 'east', 'south'],
      ['fa', 'east', 'south', 'west', 'north', 'fa'],
    ];
    const wins = findWins(g(rows), cfg, BET);
    expect(wins).toHaveLength(2);
    for (const w of wins) {
      expect(w.count).toBe(8);
      expect(w.positions).toContainEqual({ col: 2, row: 2 });
    }
  });

  it('12+ 个 → tier 12', () => {
    const rows: SymbolId[][] = [
      ['tiao', 'tiao', 'tiao', 'tiao', 'tiao', 'tiao'],
      ['tiao', 'tiao', 'tiao', 'tiao', 'tiao', 'tiao'],
      ['zhong', 'fa', 'east', 'south', 'west', 'north'],
      ['zhong', 'fa', 'east', 'south', 'west', 'north'],
      ['zhong', 'fa', 'east', 'south', 'west', 'north'],
    ];
    const wins = findWins(g(rows), cfg, BET);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.tier).toBe(12);
    expect(wins[0]!.count).toBe(12);
  });

  it('scatter/gold 不参与计数，8 个 scatter 也不成组', () => {
    const rows = NO_WIN.map((r) => [...r]);
    const marks: Array<[number, number, SymbolId]> = [
      [0, 0, 'scatter'], [0, 1, 'scatter'], [1, 1, 'scatter'], [2, 2, 'scatter'],
      [3, 3, 'scatter'], [4, 4, 'scatter'], [4, 5, 'scatter'], [2, 0, 'scatter'],
    ];
    expect(findWins(g(withCells(rows as SymbolId[][], marks)), cfg, BET)).toEqual([]);
  });
});

describe('removeAndDrop（打出去 → 上方落下 → 顶部摸新牌）', () => {
  it('消除后上方牌保序下落，新牌从顶补入', () => {
    const rows: SymbolId[][] = [
      ['zhong', 'fa', 'east', 'south', 'west', 'north'],
      ['wan', 'tong', 'tiao', 'zhong', 'fa', 'east'],
      ['south', 'west', 'north', 'wan', 'tong', 'tiao'],
      ['zhong', 'fa', 'east', 'south', 'west', 'north'],
      ['wan', 'tong', 'tiao', 'zhong', 'fa', 'east'],
    ];
    const grid = g(rows);
    // 消除第 0 列的 row 2、row 4（south、wan）
    const next = removeAndDrop(grid, [
      { col: 0, row: 2 },
      { col: 0, row: 4 },
    ], () => ({ symbol: 'fa' as const }));

    // 第 0 列原顺序 zhong,wan,south,zhong,wan → 剩 zhong,wan,zhong 落到底部保序
    expect(next[0]!.map((c) => c.symbol)).toEqual(['fa', 'fa', 'zhong', 'wan', 'zhong']);
    // 其他列不动
    expect(next[1]!.map((c) => c.symbol)).toEqual(grid[1]!.map((c) => c.symbol));
    // 原 grid 不被修改（纯函数）
    expect(grid[0]!.map((c) => c.symbol)).toEqual(['zhong', 'wan', 'south', 'zhong', 'wan']);
  });
});
