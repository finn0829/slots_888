import type { Cell, GameConfig, Grid, NormalSymbolId, Position, WinGroup } from './types';

const NORMAL_SYMBOLS: NormalSymbolId[] = [
  'zhong', 'fa', 'east', 'south', 'west', 'north', 'wan', 'tong', 'tiao',
];

export { NORMAL_SYMBOLS };

/** 全盘计数判定：任一普通符号 自身数+wild 数 ≥8 即中奖；wild 可同时计入多组 */
export function findWins(grid: Grid, config: GameConfig, bet: number): WinGroup[] {
  const positionsBySymbol = new Map<NormalSymbolId, Position[]>();
  const wildPositions: Position[] = [];

  for (let col = 0; col < grid.length; col++) {
    const column = grid[col]!;
    for (let row = 0; row < column.length; row++) {
      const sym = column[row]!.symbol;
      if (sym === 'wild') {
        wildPositions.push({ col, row });
      } else if (sym !== 'scatter' && sym !== 'gold') {
        let list = positionsBySymbol.get(sym);
        if (!list) positionsBySymbol.set(sym, (list = []));
        list.push({ col, row });
      }
    }
  }

  const wins: WinGroup[] = [];
  for (const symbol of NORMAL_SYMBOLS) {
    const own = positionsBySymbol.get(symbol);
    if (!own) continue;
    const count = own.length + wildPositions.length;
    if (count < 8) continue;
    const tier: WinGroup['tier'] = count >= 12 ? 12 : count >= 10 ? 10 : 8;
    const tierIndex = tier === 12 ? 2 : tier === 10 ? 1 : 0;
    wins.push({
      symbol,
      count,
      positions: [...own, ...wildPositions],
      tier,
      basePayout: Math.round(bet * config.symbols[symbol].pay[tierIndex] * config.payoutScale),
    });
  }
  return wins;
}

/** 消除 + 下落 + 顶部补牌（纯函数，不改原盘面）。refill 按"该列缺几张就调用几次"，自顶向下。 */
export function removeAndDrop(grid: Grid, removed: Position[], refill: (col: number) => Cell): Grid {
  const removedByCol = new Map<number, Set<number>>();
  for (const p of removed) {
    let set = removedByCol.get(p.col);
    if (!set) removedByCol.set(p.col, (set = new Set()));
    set.add(p.row);
  }

  return grid.map((column, col) => {
    const gone = removedByCol.get(col);
    if (!gone || gone.size === 0) return column.map((c) => ({ ...c }));
    const survivors = column.filter((_, row) => !gone.has(row)).map((c) => ({ ...c }));
    const fresh: Cell[] = [];
    for (let i = 0; i < gone.size; i++) fresh.push(refill(col));
    return [...fresh, ...survivors];
  });
}
