// Web Audio 合成音效（零音频文件）：麻将脆响、金箔、五档赢奖、锣
import type { WinTier } from '@slots/engine';

const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5]; // C 宫五声 + 高八度

export class Sound {
  private ctx: AudioContext | null = null;
  muted = localStorage.getItem('slots888_muted') === '1';

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      try { this.ctx = new AudioContext(); } catch { return null; }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('slots888_muted', this.muted ? '1' : '0');
    return this.muted;
  }

  /** 短促音：osc + 指数衰减包络 */
  private tone(freq: number, opts: { type?: OscillatorType; dur?: number; gain?: number; when?: number; glideTo?: number } = {}) {
    const ctx = this.ensure();
    if (!ctx) return;
    const { type = 'sine', dur = 0.18, gain = 0.16, when = 0 } = opts;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 滤波噪声（麻将牌的"啪"、金箔的"沙"） */
  private noise(opts: { dur?: number; freq?: number; q?: number; gain?: number; when?: number } = {}) {
    const ctx = this.ensure();
    if (!ctx) return;
    const { dur = 0.05, freq = 2600, q = 1.2, gain = 0.18, when = 0 } = opts;
    const t0 = ctx.currentTime + when;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
  }

  /** 麻将牌落桌的脆响 */
  land() {
    this.noise({ dur: 0.035, freq: 3400, gain: 0.14 });
    this.tone(190, { type: 'sine', dur: 0.06, gain: 0.1 });
  }

  /** 打出去：金箔沙响 + 小铃 */
  remove() {
    this.noise({ dur: 0.12, freq: 5200, q: 0.8, gain: 0.1 });
    this.tone(1318.5, { type: 'triangle', dur: 0.14, gain: 0.08, glideTo: 880 });
  }

  /** 连锁倍数弹出 */
  pop(mult: number) {
    const idx = Math.min(PENTA.length - 1, 1 + Math.round(Math.log2(mult)));
    this.tone(PENTA[idx]!, { type: 'triangle', dur: 0.22, gain: 0.14 });
    this.tone(PENTA[idx]! * 2, { type: 'sine', dur: 0.3, gain: 0.05, when: 0.03 });
  }

  /** 五档赢奖：五声音阶琶音，档位越高越长越亮 */
  tier(tier: WinTier) {
    const runs: Record<WinTier, number[]> = {
      peng: [0, 2],
      gang: [0, 2, 4],
      hu: [0, 1, 2, 4, 5],
      zimo: [0, 2, 4, 5, 4, 5],
      tianhu: [0, 1, 2, 3, 4, 5, 5],
    };
    const speed = tier === 'peng' ? 0.1 : 0.09;
    runs[tier].forEach((n, i) => {
      this.tone(PENTA[n]!, { type: 'triangle', dur: 0.3, gain: 0.15, when: i * speed });
      this.tone(PENTA[n]! * 2, { type: 'sine', dur: 0.25, gain: 0.05, when: i * speed + 0.02 });
    });
    if (tier === 'zimo' || tier === 'tianhu') this.gong(0.05);
  }

  /** 锣（免费旋转/大奖） */
  gong(when = 0) {
    this.tone(98, { type: 'sine', dur: 1.6, gain: 0.22, when });
    this.tone(147, { type: 'sine', dur: 1.3, gain: 0.12, when });
    this.tone(196.5, { type: 'triangle', dur: 1.0, gain: 0.06, when });
    this.noise({ dur: 0.4, freq: 900, q: 0.6, gain: 0.06, when });
  }
}
