// 全屏效果层：环境金箔慢飘（氛围）+ 大奖金雨（胡/自摸/天胡）+ 震屏
const GOLD = ['rgba(227,201,138,', 'rgba(201,164,92,', 'rgba(246,227,172,'];

interface Mote {
  x: number; y: number; vy: number; sway: number; phase: number;
  size: number; tone: string; alpha: number; rain: boolean; born: number; ttl: number;
}

export class Fx {
  private ctx: CanvasRenderingContext2D;
  private motes: Mote[] = [];
  private last = performance.now();
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (!this.reducedMotion) this.seedAmbient();
    const loop = (now: number) => {
      const dt = Math.min(50, now - this.last);
      this.last = now;
      this.draw(now, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private seedAmbient() {
    for (let i = 0; i < 16; i++) {
      this.motes.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vy: 0.12 + Math.random() * 0.22,
        sway: 14 + Math.random() * 22,
        phase: Math.random() * Math.PI * 2,
        size: 1.6 + Math.random() * 2.6,
        tone: GOLD[Math.floor(Math.random() * GOLD.length)]!,
        alpha: 0.1 + Math.random() * 0.2,
        rain: false, born: 0, ttl: Infinity,
      });
    }
  }

  /** 大奖金雨：intensity 1=胡 2=自摸 3=天胡 */
  rain(intensity: number) {
    if (this.reducedMotion) return;
    const n = 45 * intensity;
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      this.motes.push({
        x: Math.random() * window.innerWidth,
        y: -20 - Math.random() * window.innerHeight * 0.5,
        vy: 2.2 + Math.random() * 3.2,
        sway: 8 + Math.random() * 18,
        phase: Math.random() * Math.PI * 2,
        size: 3 + Math.random() * 5,
        tone: GOLD[Math.floor(Math.random() * GOLD.length)]!,
        alpha: 0.5 + Math.random() * 0.5,
        rain: true, born: now, ttl: 2600 + Math.random() * 1400,
      });
    }
  }

  private draw(now: number, dt: number) {
    const w = window.innerWidth, h = window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);
    const alive: Mote[] = [];
    for (const m of this.motes) {
      if (m.rain && now - m.born > m.ttl) continue;
      m.y += m.vy * dt / 16 * (m.rain ? 1.6 : 1);
      m.phase += 0.008 * dt / 16 * (m.rain ? 3 : 1);
      const x = m.x + Math.sin(m.phase) * m.sway;
      if (m.y > h + 20) {
        if (m.rain) continue;
        m.y = -10; m.x = Math.random() * w;
      }
      const fade = m.rain ? Math.max(0, 1 - (now - m.born) / m.ttl) : (0.6 + 0.4 * Math.sin(m.phase * 2));
      this.ctx.save();
      this.ctx.translate(x, m.y);
      this.ctx.rotate(m.phase * (m.rain ? 2 : 0.6));
      this.ctx.scale(1, Math.abs(Math.sin(m.phase * 1.4)) * 0.75 + 0.25);
      this.ctx.fillStyle = `${m.tone}${(m.alpha * fade).toFixed(3)})`;
      this.ctx.fillRect(-m.size / 2, -m.size / 2, m.size, m.size * 0.7);
      this.ctx.restore();
      alive.push(m);
    }
    this.motes = alive;
  }
}

/** 震屏（天胡） */
export function shake(el: HTMLElement) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.remove('shake');
  void el.offsetWidth; // 重置动画
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 650);
}
