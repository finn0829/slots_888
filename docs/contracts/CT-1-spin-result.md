# CT-1 · SpinResult 数据结构（v0.1 草案）

> 生产者：`packages/engine`。消费者：server（落库/返回）、web（演出）、admin（审计回放）。
> 变更记录：2026-07-14 v0.1 初稿；同日用户确认：scatter 仅计首盘面、免费旋转公式 10+2×(骰子数−4)、经济数值（初始 10,000 文 / 注档 10–500）。
> 2026-07-14 v0.4（ENG-10 重校）：`GameConfig` 新增 **`nominalRtp`**——该配置由 `analyze()` 实测标定的返奖率，**玩家侧公示的就是这个数**（经 `/api/config` 的 `rtp` 字段下发，前端不得写死）。同时修了 `analyze()` 的一处**偏差**：保底通道原按 `E[单段价值] × (10 / avgAward)` 线性折算，但免费旋转的价值随次数**超线性**增长（累计倍数滚雪球），导致保底被高估、基准档 RTP 被报成 97.4%（真值 95.7%）。四档 scale 已按修正后的分析器重标。详见 `docs/reports/eng10-preset-rtp.md`。
> 2026-07-14 v0.3（ENG-6b 修正）：ante 的 scatter 权重系数定为 **×1.16**（1.12 时 ante 档 RTP 89% < 基础档 95.6%，加注反更亏，方向错误）。用方差缩减分析器（`analyze.ts`）复测：1.16 → 免费旋转触发 1/155→1/93（快 1.67 倍），RTP 略高 0.9%。该参数极敏感（1.14 亏 3%，1.17 赚 2%），改动必须重跑 analyze。详见 `docs/reports/eng6b-ante-math.md`。
> 2026-07-14 v0.2（ENG-1 调参结论）：① ante 的 scatter 权重系数由 ×2 改为 ×1.12（触发概率对权重近似四次方敏感，×2 会使触发率涨约 8.8 倍即 1/152→1/17，击穿 RTP）——**已被 v0.3 取代**；② 连锁倍数阶梯超出末档 10 后每级 **+5**（15, 20, 25…），免费局按阶梯格位跨 spin 推进；③ 封顶 5000× 为**单 spin 语义**，免费旋转整段总和可超过（是否改为整段封顶待定）；④ 基础局 accumulatedMultiplierAfter 恒为 0。

engine 对外只有一个入口纯函数：

```ts
function spin(input: SpinInput): SpinResult
```

同 `seed` + 同 `config` + 同 `input` ⇒ 结果逐字节一致（审计回放的根基）。

## 类型定义

```ts
/** 符号 ID（12 种） */
type SymbolId =
  | 'zhong'   // 中（红中）— 顶级
  | 'fa'      // 發 — 高级
  | 'east' | 'south' | 'west' | 'north'  // 東南西北 — 中级
  | 'wan' | 'tong' | 'tiao'              // 萬筒條（各取一张代表）— 低级
  | 'wild'    // 白板 — 万能，替代普通牌（不替代 scatter/gold）
  | 'scatter' // 骰子 — 触发免费旋转，计入保底进度
  | 'gold';   // 金牌 — 仅免费旋转出现，自带倍数

/** 盘面：grid[col][row]，6 列 × 5 行；col 0 = 最左列，row 0 = 最顶行；新牌从顶部落入 */
type Grid = Cell[][];

interface Cell {
  symbol: SymbolId;
  /** 仅 symbol === 'gold' 时存在 */
  goldMultiplier?: 2 | 5 | 20 | 100;
}

interface Position { col: number; row: number } // 0-based

/** 一个中奖组（同一符号的全盘计数） */
interface WinGroup {
  symbol: Exclude<SymbolId, 'wild' | 'scatter' | 'gold'>;
  count: number;              // 含并入的 wild 数
  positions: Position[];      // 含 wild 的位置
  tier: 8 | 10 | 12;          // 赔付档：8–9 / 10–11 / 12+
  basePayout: number;         // 文，未乘连锁倍数
}

/** 一次连锁步骤（首次落牌算第 1 步） */
interface CascadeStep {
  gridBefore: Grid;           // 本步判定前的盘面
  wins: WinGroup[];           // 空数组 = 本步无中奖，连锁终止
  removedPositions: Position[];
  chainMultiplier: number;    // 本步生效倍数（基础局 1/2/3/5/10；免费局为累加值）
  stepWin: number;            // 文 = Σ basePayout × chainMultiplier
  gridAfter: Grid;            // 消除+下落+补牌后的盘面（最后一步 = 最终盘面）
}

type WinTier = 'peng' | 'gang' | 'hu' | 'zimo' | 'tianhu';
// 阈值（totalWin / bet）：碰 ≥5×，杠 ≥10×，胡了 ≥25×，自摸 ≥50×，天胡 ≥100×；<5× 无横幅

interface SpinInput {
  seed: string;               // 服务端生成，CSPRNG
  bet: number;                // 文，基础注（不含 ante 加成）
  anteEnabled: boolean;       // true 时实际扣款 = bet × 1.25，scatter 权重翻倍
  mode: 'base' | 'free';
  /** mode==='free' 时必填：进入免费旋转时已累加的倍数 */
  accumulatedMultiplier?: number;
  config: GameConfig;         // 见 engine 导出的 GameConfig 类型（含符号权重/赔付表/规则参数）
}

interface SpinResult {
  // ── 回放必需的输入回显 ──
  seed: string;
  bet: number;
  totalCost: number;          // 实际扣款（ante 时 = bet×1.25；free 模式 = 0）
  anteEnabled: boolean;
  mode: 'base' | 'free';

  // ── 过程 ──
  cascades: CascadeStep[];    // 至少 1 步；[0].gridBefore 即本次落牌盘面
  scatterCount: number;       // 首盘面骰子数（保底进度 += 此值）
  goldMultipliers: number[];  // 免费局中本 spin 出现的所有金牌倍数（按出现顺序）

  // ── 结果 ──
  totalWin: number;           // 文，已含所有倍数
  winTier: WinTier | null;
  freeSpinsAwarded: number;   // 本 spin 触发/再触发获得的免费次数（0 = 未触发）
  /** 免费局结束后带出的累加倍数（供 server 持久化） */
  accumulatedMultiplierAfter: number;
}
```

## 关键规则（engine 内实现，此处为语义约定）

1. **判定**：对首盘面全盘计数，任一普通符号 `自身数 + wild 数 ≥ 8` 即中奖；一个 wild 可同时计入多个中奖组；消除时 wild 与中奖符号一起"打出"。
2. **连锁倍数**：基础局按步 ×1→×2→×3→×5→×10（第 5 步起恒 ×10）；免费局用 `accumulatedMultiplier`，每有中奖步则按同表递增且**跨 spin 不重置**。
3. **金牌**：不参与计数、不可被消除；免费局的一次 spin 内所有金牌倍数**相加**，乘到该 spin 的 totalWin 上。
4. **scatter**：只看首盘面（连锁补入的骰子计入下一次？——**否**，仅首盘面，规则从简）；`≥4 个 → freeSpinsAwarded = 10 + 2×(scatterCount−4)`（再触发同公式，v0.1 暂定，ENG-4 调参后可改）。
5. **封顶**：totalWin ≤ 5000 × bet，触顶即截断并终止连锁。
6. 保底进度、余额、免费次数是**服务端状态**，不在 SpinResult 内——见 CT-2 的 `PlayerState`。
