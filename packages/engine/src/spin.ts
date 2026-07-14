import { createRng, type Rng } from './rng';
import { findWins, removeAndDrop, NORMAL_SYMBOLS } from './grid';
import type {
  CascadeStep, Cell, GameConfig, GoldMultiplier, Grid, Position, SpinInput, SpinResult, WinTier,
} from './types';

/** 连锁倍数阶梯：超出末档后每级 +ladderStepAfter（10 → 15 → 20 …） */
export function ladderValue(config: GameConfig, rung: number): number {
  const ladder = config.chainLadder;
  if (rung < ladder.length) return ladder[rung]!;
  return ladder[ladder.length - 1]! + config.ladderStepAfter * (rung - ladder.length + 1);
}

function ladderRungOf(config: GameConfig, value: number): number {
  if (!value || value <= 0) return 0;
  for (let rung = 0; rung < 100_000; rung++) {
    if (ladderValue(config, rung) >= value) return rung;
  }
  return 0;
}

/** 赢奖分级：碰 ≥5×，杠 ≥10×，胡了 ≥25×，自摸 ≥50×，天胡 ≥100× */
export function winTierFor(totalWin: number, bet: number): WinTier | null {
  const x = totalWin / bet;
  if (x >= 100) return 'tianhu';
  if (x >= 50) return 'zimo';
  if (x >= 25) return 'hu';
  if (x >= 10) return 'gang';
  if (x >= 5) return 'peng';
  return null;
}

interface WeightEntry { symbol: Cell['symbol']; weight: number }

/** 抽牌表。RNG 消耗顺序固定：每格 1 次抽符号，金牌再 +1 次抽倍数。 */
function buildTable(config: GameConfig, opts: { scatter: boolean; gold: boolean; anteEnabled: boolean }): { entries: WeightEntry[]; total: number } {
  const entries: WeightEntry[] = NORMAL_SYMBOLS.map((s) => ({ symbol: s, weight: config.symbols[s].weight }));
  entries.push({ symbol: 'wild', weight: config.wildWeight });
  if (opts.scatter) {
    entries.push({ symbol: 'scatter', weight: config.scatterWeight * (opts.anteEnabled ? config.anteScatterFactor : 1) });
  }
  if (opts.gold) entries.push({ symbol: 'gold', weight: config.goldWeight });
  return { entries, total: entries.reduce((s, e) => s + e.weight, 0) };
}

function drawCell(rng: Rng, table: { entries: WeightEntry[]; total: number }, config: GameConfig, collectGold: number[]): Cell {
  let roll = rng.next() * table.total;
  let symbol: Cell['symbol'] = table.entries[table.entries.length - 1]!.symbol;
  for (const e of table.entries) {
    if (roll < e.weight) { symbol = e.symbol; break; }
    roll -= e.weight;
  }
  if (symbol !== 'gold') return { symbol };
  const goldTotal = config.goldValues.reduce((s, g) => s + g.weight, 0);
  let gRoll = rng.next() * goldTotal;
  let multiplier: GoldMultiplier = config.goldValues[config.goldValues.length - 1]!.multiplier;
  for (const g of config.goldValues) {
    if (gRoll < g.weight) { multiplier = g.multiplier; break; }
    gRoll -= g.weight;
  }
  collectGold.push(multiplier);
  return { symbol, goldMultiplier: multiplier };
}

/** 唯一入口纯函数（CT-1）：同 seed + 同 config + 同 input ⇒ 结果逐字节一致 */
export function spin(input: SpinInput): SpinResult {
  const { seed, bet, anteEnabled, mode, config } = input;
  if (!Number.isInteger(bet) || bet <= 0) throw new Error(`非法下注: ${bet}`);

  const rng = createRng(seed);
  const goldMultipliers: number[] = [];
  const isFree = mode === 'free';

  // 初盘面：可含 scatter（仅此处）；免费局可含金牌
  const initialTable = buildTable(config, { scatter: true, gold: isFree, anteEnabled });
  // 补牌：永不出 scatter（CT-1 规则 4/6）
  const refillTable = buildTable(config, { scatter: false, gold: isFree, anteEnabled });

  let grid: Grid = [];
  for (let col = 0; col < config.columns; col++) {
    const column: Cell[] = [];
    for (let row = 0; row < config.rows; row++) column.push(drawCell(rng, initialTable, config, goldMultipliers));
    grid.push(column);
  }

  const scatterCount = grid.flat().filter((c) => c.symbol === 'scatter').length;

  const cap = bet * config.maxWinX;
  const cascades: CascadeStep[] = [];
  let totalWin = 0;
  let rung = isFree ? ladderRungOf(config, input.accumulatedMultiplier ?? 1) : 0;

  for (;;) {
    const wins = findWins(grid, config, bet);
    if (wins.length === 0) {
      if (cascades.length === 0) {
        cascades.push({ gridBefore: grid, wins: [], removedPositions: [], chainMultiplier: ladderValue(config, rung), stepWin: 0, gridAfter: grid });
      }
      break;
    }
    const chainMultiplier = ladderValue(config, rung);
    const stepWin = wins.reduce((s, w) => s + w.basePayout, 0) * chainMultiplier;
    totalWin += stepWin;

    const removedKeys = new Set<string>();
    const removedPositions: Position[] = [];
    for (const w of wins) {
      for (const p of w.positions) {
        const key = `${p.col},${p.row}`;
        if (!removedKeys.has(key)) { removedKeys.add(key); removedPositions.push(p); }
      }
    }

    const gridAfter = removeAndDrop(grid, removedPositions, () => drawCell(rng, refillTable, config, goldMultipliers));
    cascades.push({ gridBefore: grid, wins, removedPositions, chainMultiplier, stepWin, gridAfter });
    grid = gridAfter;
    rung++;

    if (totalWin >= cap) { totalWin = cap; break; }
  }

  // 免费局：金牌倍数相加后乘到本 spin 总赢（有赢才乘），再封顶
  if (isFree && totalWin > 0 && goldMultipliers.length > 0) {
    const goldSum = goldMultipliers.reduce((a, b) => a + b, 0);
    totalWin = Math.min(totalWin * goldSum, cap);
  }

  const fs = config.freeSpins;
  const freeSpinsAwarded = scatterCount >= fs.trigger ? fs.base + fs.perExtra * (scatterCount - fs.trigger) : 0;

  return {
    seed,
    bet,
    totalCost: isFree ? 0 : Math.round(bet * (anteEnabled ? config.anteCostMultiplier : 1)),
    anteEnabled,
    mode,
    cascades,
    scatterCount,
    goldMultipliers,
    totalWin,
    winTier: winTierFor(totalWin, bet),
    freeSpinsAwarded,
    accumulatedMultiplierAfter: isFree ? ladderValue(config, rung) : 0,
  };
}
