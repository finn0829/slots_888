// CT-1 契约类型（docs/contracts/CT-1-spin-result.md）
export type NormalSymbolId =
  | 'zhong' | 'fa'
  | 'east' | 'south' | 'west' | 'north'
  | 'wan' | 'tong' | 'tiao';

export type SymbolId = NormalSymbolId | 'wild' | 'scatter' | 'gold';

export type GoldMultiplier = 2 | 5 | 20 | 100;

export interface Cell {
  symbol: SymbolId;
  goldMultiplier?: GoldMultiplier;
}

/** grid[col][row]，6 列 × 5 行；col 0 = 最左列，row 0 = 最顶行 */
export type Grid = Cell[][];

export interface Position { col: number; row: number }

export interface WinGroup {
  symbol: NormalSymbolId;
  count: number;
  positions: Position[];
  tier: 8 | 10 | 12;
  basePayout: number;
}

export interface CascadeStep {
  gridBefore: Grid;
  wins: WinGroup[];
  removedPositions: Position[];
  chainMultiplier: number;
  stepWin: number;
  gridAfter: Grid;
}

export type WinTier = 'peng' | 'gang' | 'hu' | 'zimo' | 'tianhu';

export interface SpinInput {
  seed: string;
  bet: number;
  anteEnabled: boolean;
  mode: 'base' | 'free';
  accumulatedMultiplier?: number;
  config: GameConfig;
}

export interface SpinResult {
  seed: string;
  bet: number;
  totalCost: number;
  anteEnabled: boolean;
  mode: 'base' | 'free';
  cascades: CascadeStep[];
  scatterCount: number;
  goldMultipliers: number[];
  totalWin: number;
  winTier: WinTier | null;
  freeSpinsAwarded: number;
  accumulatedMultiplierAfter: number;
}

// ── GameConfig：一份配置 = 一款游戏（版本化存 game_configs.config_json）──

export interface SymbolConfig {
  /** 初盘/补牌的抽取权重 */
  weight: number;
  /** 三档赔付（×bet）：[8–9, 10–11, 12+] */
  pay: [number, number, number];
}

export interface GameConfig {
  presetId: string;
  columns: number;
  rows: number;
  symbols: Record<NormalSymbolId, SymbolConfig>;
  wildWeight: number;
  /** 骰子权重（仅初盘面出现；补牌不出，见 CT-1 规则 4/6） */
  scatterWeight: number;
  /** 金牌权重（仅免费旋转出现） */
  goldWeight: number;
  goldValues: Array<{ multiplier: GoldMultiplier; weight: number }>;
  /** 连锁倍数阶梯 [1,2,3,5,10]，超出末档后每级 +ladderStepAfter */
  chainLadder: number[];
  ladderStepAfter: number;
  freeSpins: { trigger: number; base: number; perExtra: number };
  anteCostMultiplier: number;
  anteScatterFactor: number;
  maxWinX: number;
  /** 全局赔付缩放（调 RTP 的总旋钮） */
  payoutScale: number;
  /**
   * 标定 RTP：该配置由 analyze() 实测得到的返奖率（ENG-10）。
   * 玩家侧公示的就是这个数——不许在前端写死，否则改了权重它就成了谎言。
   * 后台改过权重的草稿配置须重跑模拟器，用估算值覆盖（见 /api/config 的 rtp 字段）。
   */
  nominalRtp: number;
}
