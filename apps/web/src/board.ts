// Canvas 盘面渲染 + 消除下落动画
import type { Cell, Grid, Position } from '@slots/engine';
import { COLORS, drawTile } from './tiles';

interface CellSprite {
  cell: Cell;
  yOff: number;   // 像素偏移（负 = 在目标位上方）
  scale: number;
  alpha: number;
  highlight: boolean;
}

const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export class Board {
  private ctx: CanvasRenderingContext2D;
  private sprites: CellSprite[][] = [];
  private cols = 6;
  private rows = 5;
  speed = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const draw = () => { this.draw(); requestAnimationFrame(draw); };
    requestAnimationFrame(draw);
  }

  private metrics() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const gap = w * 0.012;
    const cellW = (w - gap * (this.cols + 1)) / this.cols;
    const cellH = (h - gap * (this.rows + 1)) / this.rows;
    return { w, h, gap, cellW, cellH };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw() {
    const { w, h, gap, cellW, cellH } = this.metrics();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    // 牌桌底
    ctx.fillStyle = COLORS.felt500;
    ctx.strokeStyle = COLORS.gold700;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 12);
    ctx.fill();
    ctx.stroke();

    for (let col = 0; col < this.sprites.length; col++) {
      for (let row = 0; row < (this.sprites[col]?.length ?? 0); row++) {
        const s = this.sprites[col]![row]!;
        if (s.alpha <= 0) continue;
        const x = gap + col * (cellW + gap);
        const y = gap + row * (cellH + gap) + s.yOff;
        drawTile(ctx, s.cell, x, y, cellW, cellH, {
          highlight: s.highlight, alpha: s.alpha, scale: s.scale,
        });
      }
    }
  }

  private animate(duration: number, step: (t: number) => void): Promise<void> {
    const ms = duration / this.speed;
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        step(t);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  setGrid(grid: Grid) {
    this.sprites = grid.map((col) => col.map((cell) => ({
      cell, yOff: 0, scale: 1, alpha: 1, highlight: false,
    })));
  }

  /** 落牌入场：整列从上方掉入，列间错峰 */
  async dropIn(grid: Grid) {
    const { cellH, gap, h } = this.metrics();
    this.setGrid(grid);
    const drop = h + cellH;
    for (const col of this.sprites) for (const s of col) { s.yOff = -drop; }
    const stagger = 60;
    const dur = 320;
    const total = dur + stagger * (this.cols - 1);
    await this.animate(total, (t) => {
      const now = t * total;
      for (let c = 0; c < this.sprites.length; c++) {
        const local = Math.min(1, Math.max(0, (now - c * stagger) / dur));
        const e = easeOutBack(local);
        for (const s of this.sprites[c]!) s.yOff = -drop * (1 - e);
      }
    });
  }

  /** 高亮中奖牌 */
  async flashWins(positions: Position[], ms = 450) {
    for (const p of positions) this.sprites[p.col]![p.row]!.highlight = true;
    await this.animate(ms, () => {});
  }

  /** 打出去：中奖牌先弹大再缩小消失 */
  async removeTiles(positions: Position[]) {
    await this.animate(200, (t) => {
      for (const p of positions) {
        const s = this.sprites[p.col]![p.row]!;
        s.scale = t < 0.35 ? 1 + 0.35 * t : Math.max(0, 1.12 * (1 - (t - 0.35) / 0.65));
        s.alpha = t < 0.5 ? 1 : Math.max(0, 1 - (t - 0.5) / 0.5);
      }
    });
  }

  /** 摸牌补位：removed 之上的牌下落，新牌从顶落入 */
  async applyAfter(gridAfter: Grid, removed: Position[]) {
    const { cellH, gap } = this.metrics();
    const unit = cellH + gap;
    const removedByCol = new Map<number, Set<number>>();
    for (const p of removed) {
      if (!removedByCol.has(p.col)) removedByCol.set(p.col, new Set());
      removedByCol.get(p.col)!.add(p.row);
    }

    const old = this.sprites;
    this.setGrid(gridAfter);

    for (let col = 0; col < this.cols; col++) {
      const gone = removedByCol.get(col);
      if (!gone || gone.size === 0) continue;
      const k = gone.size;
      const survivors: number[] = [];
      for (let row = 0; row < this.rows; row++) if (!gone.has(row)) survivors.push(row);
      // 新列：前 k 行是新牌（从顶上掉入），后面是幸存者（从原行落到新行）
      for (let row = 0; row < this.rows; row++) {
        const s = this.sprites[col]![row]!;
        if (row < k) {
          // 新牌：从顶上方掉入
          s.yOff = -(k - row + 1) * unit - unit * 0.5;
        } else {
          // 幸存者：从原行落到新行
          const oldRow = survivors[row - k]!;
          s.yOff = (oldRow - row) * unit;
        }
      }
    }
    void old;

    // 基于初始偏移插值（回弹落地）
    const moving: Array<{ s: CellSprite; from: number }> = [];
    for (const col of this.sprites) for (const s of col) {
      if (s.yOff !== 0) moving.push({ s, from: s.yOff });
    }
    await this.animate(300, (t) => {
      const e = easeOutBack(t);
      for (const m of moving) m.s.yOff = m.from * (1 - e);
    });
    for (const m of moving) m.s.yOff = 0;
  }
}
