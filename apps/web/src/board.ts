// Canvas 盘面：图集贴图 + 消除金箔粒子 + 落地压弹（squash & stretch）
import type { Grid, Position } from '@slots/engine';
import { COLORS, TileAtlas, type Cell } from './tiles';

interface CellSprite {
  cell: Cell;
  yOff: number;
  scale: number;
  alpha: number;
  highlight: boolean;
  landAt: number; // 落地时刻（触发压弹）
}

interface Flake {
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; size: number; born: number; ttl: number;
  color: string;
}

const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const GOLD_TONES = ['#E3C98A', '#C9A45C', '#F6E3AC', '#B33A3A'];

export class Board {
  private ctx: CanvasRenderingContext2D;
  private sprites: CellSprite[][] = [];
  private flakes: Flake[] = [];
  private atlas = new TileAtlas();
  private feltPattern: CanvasPattern | null = null;
  private lastFrame = performance.now();
  private cols = 6;
  private rows = 5;
  private anticipateCol = -1;
  speed = 1;
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 每列落定回调（音效钩子） */
  onColumnLand?: () => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const draw = (now: number) => {
      const dt = Math.min(50, now - this.lastFrame);
      this.lastFrame = now;
      this.draw(now, dt);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  /** 字体就绪后调用：清图集缓存重绘 */
  refreshAtlas() { this.atlas.clear(); }

  private metrics() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const gap = w * 0.014;
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
    this.atlas.clear();
  }

  private feltTexture(): CanvasPattern | null {
    if (this.feltPattern) return this.feltPattern;
    const c = document.createElement('canvas');
    c.width = c.height = 72;
    const pctx = c.getContext('2d')!;
    pctx.fillStyle = COLORS.felt500;
    pctx.fillRect(0, 0, 72, 72);
    // 织纹：斜向短纤维
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 72, y = Math.random() * 72;
      const l = 1.5 + Math.random() * 2.5;
      const a = Math.random() * Math.PI;
      pctx.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.05)';
      pctx.lineWidth = 0.8;
      pctx.beginPath();
      pctx.moveTo(x, y);
      pctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      pctx.stroke();
    }
    this.feltPattern = this.ctx.createPattern(c, 'repeat');
    return this.feltPattern;
  }

  private draw(now: number, dt: number) {
    const { w, h, gap, cellW, cellH } = this.metrics();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // 毛毡桌面 + 内阴影（被木框压住的感觉）
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.fillStyle = this.feltTexture() ?? COLORS.felt500;
    ctx.fill();
    ctx.save();
    ctx.clip();
    const inner = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.72);
    inner.addColorStop(0, 'rgba(0,0,0,0)');
    inner.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = inner;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // 近失悬念：当前慢落列的金光聚焦
    if (this.anticipateCol >= 0) {
      const x = gap + this.anticipateCol * (cellW + gap) - gap / 2;
      ctx.fillStyle = `rgba(227,201,138,${(0.1 + 0.08 * Math.sin(now / 110)).toFixed(3)})`;
      ctx.beginPath();
      ctx.roundRect(x, gap / 2, cellW + gap, h - gap, 8);
      ctx.fill();
    }

    // 牌
    for (let col = 0; col < this.sprites.length; col++) {
      for (let row = 0; row < (this.sprites[col]?.length ?? 0); row++) {
        const s = this.sprites[col]![row]!;
        if (s.alpha <= 0) continue;
        const x = gap + col * (cellW + gap);
        const y = gap + row * (cellH + gap) + s.yOff;

        // 落地压弹：160ms 内 scaleY 下压回弹，锚定底边
        let drawW = cellW, drawH = cellH, dx = x, dy = y;
        if (!this.reducedMotion && s.landAt > 0) {
          const p = (now - s.landAt) / 160;
          if (p < 1) {
            const squash = 1 - 0.14 * Math.sin(Math.PI * p);
            drawH = cellH * squash;
            drawW = cellW * (2 - squash) * 0.5 + cellW * 0.5; // 轻微横向补偿
            dy = y + (cellH - drawH);
            dx = x - (drawW - cellW) / 2;
          } else s.landAt = 0;
        }
        if (s.scale !== 1) {
          const sw = drawW * s.scale, sh = drawH * s.scale;
          dx += (drawW - sw) / 2; dy += (drawH - sh) / 2;
          drawW = sw; drawH = sh;
        }

        const special = s.cell.symbol === 'scatter' || s.cell.symbol === 'gold' || s.cell.symbol === 'wild';
        ctx.save();
        ctx.globalAlpha = s.alpha;
        if (s.highlight) {
          // 呼吸金光
          ctx.shadowColor = 'rgba(227,201,138,0.95)';
          ctx.shadowBlur = cellW * (0.16 + 0.08 * Math.sin(now / 130));
        } else if (special && !this.reducedMotion) {
          // 特殊牌（骰子/金牌/白板）常驻呼吸光，稀有感
          ctx.shadowColor = 'rgba(227,201,138,0.8)';
          ctx.shadowBlur = cellW * (0.09 + 0.05 * Math.sin(now / 300 + col * 1.7 + row));
        } else {
          ctx.shadowColor = 'rgba(0,0,0,0.35)';
          ctx.shadowBlur = 4;
          ctx.shadowOffsetY = 2;
        }
        ctx.drawImage(this.atlas.get(s.cell, cellW, cellH, s.highlight), dx, dy, drawW, drawH);
        ctx.restore();
      }
    }

    // 金箔粒子
    if (this.flakes.length > 0) {
      const alive: Flake[] = [];
      for (const f of this.flakes) {
        const age = now - f.born;
        if (age > f.ttl) continue;
        f.x += f.vx * dt / 16;
        f.y += f.vy * dt / 16;
        f.vy += 0.22 * dt / 16;
        f.rot += f.vr * dt / 16;
        const lifeT = age / f.ttl;
        ctx.save();
        ctx.globalAlpha = lifeT < 0.7 ? 1 : 1 - (lifeT - 0.7) / 0.3;
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.scale(1, Math.abs(Math.sin(f.rot * 1.7)) * 0.8 + 0.2); // 翻转的箔片
        ctx.fillStyle = f.color;
        ctx.fillRect(-f.size / 2, -f.size / 2, f.size, f.size * 0.72);
        ctx.restore();
        alive.push(f);
      }
      this.flakes = alive;
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

  /** 当前盘面（e2e 用来断言"刷新后摆的是上一局的终盘"，像素比对不可靠：牌面有微光动画） */
  currentGrid(): Grid {
    return this.sprites.map((col) => col.map((s) => s.cell));
  }

  setGrid(grid: Grid) {
    this.sprites = grid.map((col) => col.map((cell) => ({
      cell, yOff: 0, scale: 1, alpha: 1, highlight: false, landAt: 0,
    })));
  }

  /** 落牌入场：列间错峰；已见 ≥3 骰子时剩余列进入近失悬念（逐列慢落 + 金光聚焦） */
  async dropIn(grid: Grid) {
    const { cellH, h } = this.metrics();
    this.setGrid(grid);
    const drop = h + cellH;
    for (const col of this.sprites) for (const s of col) s.yOff = -drop;

    // 真实近失才触发：落到某列时累计已见 3 个骰子，且后面还有列
    let anticipateFrom = -1;
    if (!this.reducedMotion) {
      let cum = 0;
      for (let c = 0; c < this.cols - 1; c++) {
        cum += grid[c]!.filter((cell) => cell.symbol === 'scatter').length;
        if (cum === 3) { anticipateFrom = c + 1; break; }
        if (cum > 3) break; // 已经 ≥4，直接触发免费旋转，无需吊胃口
      }
    }

    const normalUntil = anticipateFrom >= 0 ? anticipateFrom : this.cols;
    await this.dropColumns(0, normalUntil, drop, 300, 55);
    if (anticipateFrom >= 0) {
      for (let c = anticipateFrom; c < this.cols; c++) {
        this.anticipateCol = c;
        await this.dropColumns(c, c + 1, drop, 820, 0);
      }
      this.anticipateCol = -1;
    }
    for (const col of this.sprites) for (const s of col) s.yOff = 0;
  }

  private async dropColumns(from: number, to: number, drop: number, dur: number, stagger: number) {
    const total = dur + stagger * Math.max(0, to - from - 1);
    const landed = new Set<number>();
    await this.animate(total, (t) => {
      const now = t * total;
      for (let c = from; c < to; c++) {
        const local = Math.min(1, Math.max(0, (now - (c - from) * stagger) / dur));
        const e = easeOutBack(local);
        for (const s of this.sprites[c]!) s.yOff = -drop * (1 - e);
        if (local >= 1 && !landed.has(c)) {
          landed.add(c);
          const ts = performance.now();
          for (const s of this.sprites[c]!) s.landAt = ts;
          this.onColumnLand?.();
        }
      }
    });
    for (let c = from; c < to; c++) for (const s of this.sprites[c]!) s.yOff = 0;
  }

  async flashWins(positions: Position[], ms = 420) {
    for (const p of positions) this.sprites[p.col]![p.row]!.highlight = true;
    await this.animate(ms, () => {});
  }

  /** 打出去：弹大缩小消失 + 每张牌爆金箔 */
  async removeTiles(positions: Position[]) {
    const { gap, cellW, cellH } = this.metrics();
    if (!this.reducedMotion) {
      for (const p of positions) {
        const cx = gap + p.col * (cellW + gap) + cellW / 2;
        const cy = gap + p.row * (cellH + gap) + cellH / 2;
        const n = 9 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 1.6 + Math.random() * 3.4;
          this.flakes.push({
            x: cx, y: cy,
            vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.8,
            rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.5,
            size: cellW * (0.06 + Math.random() * 0.08),
            born: performance.now(), ttl: 550 + Math.random() * 350,
            color: GOLD_TONES[Math.floor(Math.random() * GOLD_TONES.length)]!,
          });
        }
      }
    }
    await this.animate(200, (t) => {
      for (const p of positions) {
        const s = this.sprites[p.col]![p.row]!;
        s.scale = t < 0.35 ? 1 + 0.35 * t : Math.max(0, 1.12 * (1 - (t - 0.35) / 0.65));
        s.alpha = t < 0.5 ? 1 : Math.max(0, 1 - (t - 0.5) / 0.5);
      }
    });
  }

  /** 摸牌补位：上方牌下落、新牌顶入，落地压弹 */
  async applyAfter(gridAfter: Grid, removed: Position[]) {
    const { cellH, gap } = this.metrics();
    const unit = cellH + gap;
    const removedByCol = new Map<number, Set<number>>();
    for (const p of removed) {
      if (!removedByCol.has(p.col)) removedByCol.set(p.col, new Set());
      removedByCol.get(p.col)!.add(p.row);
    }

    this.setGrid(gridAfter);
    for (let col = 0; col < this.cols; col++) {
      const gone = removedByCol.get(col);
      if (!gone || gone.size === 0) continue;
      const k = gone.size;
      const survivors: number[] = [];
      for (let row = 0; row < this.rows; row++) if (!gone.has(row)) survivors.push(row);
      for (let row = 0; row < this.rows; row++) {
        const s = this.sprites[col]![row]!;
        if (row < k) s.yOff = -(k - row + 1) * unit - unit * 0.5;
        else s.yOff = (survivors[row - k]! - row) * unit;
      }
    }

    const moving: Array<{ s: CellSprite; from: number }> = [];
    for (const col of this.sprites) for (const s of col) {
      if (s.yOff !== 0) moving.push({ s, from: s.yOff });
    }
    await this.animate(290, (t) => {
      const e = easeOutBack(t);
      for (const m of moving) m.s.yOff = m.from * (1 - e);
    });
    const now = performance.now();
    for (const m of moving) { m.s.yOff = 0; m.s.landAt = now; }
  }
}
