// 麻将牌面材质系统（CT-4 雅致国风）
// 离屏预渲染图集：每种牌×状态只精绘一次，运行时 drawImage 贴图，材质可以画重而不掉帧。
import type { Cell } from '@slots/engine';

export const COLORS = {
  felt900: '#142B22',
  felt700: '#1B3B2F',
  felt500: '#26523F',
  ivory100: '#FBF7EC',
  ivory300: '#F5EFE0',
  ivory500: '#E4D9C0',
  ivory700: '#C9BB9C',
  gold300: '#E3C98A',
  gold500: '#C9A45C',
  gold700: '#9A7B3F',
  cinnabar500: '#B33A3A',
  cinnabar700: '#8E2C2C',
  bamboo500: '#3E7C59',
  bamboo700: '#2E5C42',
  indigo500: '#35507A',
  indigo700: '#283C5C',
  ink900: '#2B2A26',
};

const GLYPHS: Record<string, { char: string; color: string; dark: string }> = {
  zhong: { char: '中', color: COLORS.cinnabar500, dark: COLORS.cinnabar700 },
  fa: { char: '發', color: COLORS.bamboo500, dark: COLORS.bamboo700 },
  east: { char: '東', color: COLORS.indigo500, dark: COLORS.indigo700 },
  south: { char: '南', color: COLORS.indigo500, dark: COLORS.indigo700 },
  west: { char: '西', color: COLORS.indigo500, dark: COLORS.indigo700 },
  north: { char: '北', color: COLORS.indigo500, dark: COLORS.indigo700 },
  wan: { char: '萬', color: COLORS.cinnabar500, dark: COLORS.cinnabar700 },
  tong: { char: '筒', color: COLORS.indigo500, dark: COLORS.indigo700 },
  tiao: { char: '條', color: COLORS.bamboo500, dark: COLORS.bamboo700 },
};

export const KAI_FONT = '"LXGW WenKai", "Kaiti SC", KaiTi, STKaiti, "AR PL UKai CN", serif';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 暖色噪点纹理（共享，平铺用） */
let noiseCanvas: HTMLCanvasElement | null = null;
function getNoise(): HTMLCanvasElement {
  if (noiseCanvas) return noiseCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 180 + Math.random() * 75;
    img.data[i] = v; img.data[i + 1] = v * 0.98; img.data[i + 2] = v * 0.92;
    img.data[i + 3] = Math.random() < 0.5 ? 14 : 0;
  }
  ctx.putImageData(img, 0, 0);
  noiseCanvas = c;
  return c;
}

/** 刻字效果：下方 1px 亮边（受光）+ 上方 1px 暗边（凹槽阴影）+ 渐变主体 */
function engraveText(
  ctx: CanvasRenderingContext2D, char: string,
  cx: number, cy: number, size: number,
  color: string, dark: string,
) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px ${KAI_FONT}`;
  const d = Math.max(1, size * 0.022);
  // 凹槽底部受光
  ctx.fillStyle = 'rgba(255,253,244,0.9)';
  ctx.fillText(char, cx, cy + d);
  // 凹槽顶部阴影
  ctx.fillStyle = 'rgba(30,20,10,0.35)';
  ctx.fillText(char, cx, cy - d);
  // 主体：上浅下深的颜料渐变
  const g = ctx.createLinearGradient(cx, cy - size / 2, cx, cy + size / 2);
  g.addColorStop(0, color);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.fillText(char, cx, cy);
  // 描金边：笔画边缘一圈细金，像贴了金箔的漆字
  ctx.lineWidth = Math.max(0.7, size * 0.02);
  ctx.strokeStyle = 'rgba(216,178,105,0.6)';
  ctx.strokeText(char, cx, cy);
}

function paintFace(ctx: CanvasRenderingContext2D, w: number, faceH: number, r: number, bright: boolean) {
  // 基底渐变
  roundRectPath(ctx, 0, 0, w, faceH, r);
  const base = ctx.createLinearGradient(0, 0, 0, faceH);
  base.addColorStop(0, bright ? '#FFFEF8' : COLORS.ivory100);
  base.addColorStop(0.55, COLORS.ivory300);
  base.addColorStop(1, '#EDE4CE');
  ctx.fillStyle = base;
  ctx.fill();

  // 左上光泽（象牙的油润感）
  ctx.save();
  ctx.clip();
  const sheen = ctx.createRadialGradient(w * 0.28, faceH * 0.2, 0, w * 0.28, faceH * 0.2, w * 0.9);
  sheen.addColorStop(0, 'rgba(255,255,255,0.5)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, faceH);
  // 暖噪点
  ctx.globalAlpha = 0.5;
  ctx.drawImage(getNoise(), 0, 0, w, faceH);
  ctx.globalAlpha = 1;
  ctx.restore();

  // 内浮雕：顶部亮线 + 底部暗线
  roundRectPath(ctx, 0.8, 0.8, w - 1.6, faceH - 1.6, r * 0.92);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  roundRectPath(ctx, 0.6, 1.6, w - 1.2, faceH - 2.2, r * 0.92);
  ctx.strokeStyle = 'rgba(120,100,60,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 描金内框 + 四角如意角饰（牌身纹理）
  const inset = w * 0.068;
  roundRectPath(ctx, inset, inset, w - inset * 2, faceH - inset * 2, r * 0.5);
  ctx.strokeStyle = 'rgba(201,164,92,0.38)';
  ctx.lineWidth = Math.max(0.8, w * 0.012);
  ctx.stroke();
  const d = w * 0.028;
  ctx.fillStyle = 'rgba(201,164,92,0.55)';
  for (const [cx2, cy2] of [
    [inset, inset], [w - inset, inset],
    [inset, faceH - inset], [w - inset, faceH - inset],
  ] as const) {
    ctx.save();
    ctx.translate(cx2, cy2);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-d, -d, d * 2, d * 2);
    ctx.restore();
  }
}

function paintTile(ctx: CanvasRenderingContext2D, cell: Cell, w: number, h: number, highlight: boolean) {
  const r = w * 0.13;
  const side = h * 0.085;
  const faceH = h - side;

  // 底部厚度（两段：侧壁 + 底缘反光）
  roundRectPath(ctx, 0, side * 0.9, w, h - side * 0.9, r);
  const sideG = ctx.createLinearGradient(0, faceH * 0.7, 0, h);
  sideG.addColorStop(0, COLORS.ivory500);
  sideG.addColorStop(0.75, COLORS.ivory700);
  sideG.addColorStop(1, '#B5A583');
  ctx.fillStyle = sideG;
  ctx.fill();

  // 牌面
  if (cell.symbol === 'gold') {
    roundRectPath(ctx, 0, 0, w, faceH, r);
    const g = ctx.createLinearGradient(0, 0, w, faceH);
    g.addColorStop(0, '#F6E3AC');
    g.addColorStop(0.35, COLORS.gold500);
    g.addColorStop(0.7, COLORS.gold700);
    g.addColorStop(1, COLORS.gold300);
    ctx.fillStyle = g;
    ctx.fill();
    // 金属高光斜带
    ctx.save();
    ctx.clip();
    ctx.translate(w * 0.5, faceH * 0.5);
    ctx.rotate(-0.5);
    const streak = ctx.createLinearGradient(0, -faceH * 0.28, 0, faceH * 0.05);
    streak.addColorStop(0, 'rgba(255,255,255,0)');
    streak.addColorStop(0.5, 'rgba(255,252,235,0.55)');
    streak.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = streak;
    ctx.fillRect(-w, -faceH * 0.3, w * 2, faceH * 0.32);
    ctx.restore();
    roundRectPath(ctx, 1, 1, w - 2, faceH - 2, r * 0.9);
    ctx.strokeStyle = 'rgba(90,66,30,0.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    engraveText(ctx, `×${cell.goldMultiplier ?? ''}`, w / 2, faceH / 2, w * 0.4, COLORS.cinnabar500, COLORS.cinnabar700);
  } else {
    paintFace(ctx, w, faceH, r, highlight);
    const cx = w / 2;
    const cy = faceH / 2;
    if (cell.symbol === 'scatter') {
      paintDice(ctx, cx, cy, w * 0.6);
    } else if (cell.symbol === 'wild') {
      paintWild(ctx, w, faceH);
    } else {
      const g = GLYPHS[cell.symbol];
      if (g) engraveText(ctx, g.char, cx, cy * 1.04, w * 0.56, g.color, g.dark);
    }
  }

  // 高亮态描金边
  if (highlight) {
    roundRectPath(ctx, 1, 1, w - 2, faceH - 2, r * 0.9);
    ctx.strokeStyle = COLORS.gold500;
    ctx.lineWidth = Math.max(2, w * 0.035);
    ctx.stroke();
  } else {
    roundRectPath(ctx, 0.5, 0.5, w - 1, faceH - 1, r);
    ctx.strokeStyle = 'rgba(154,123,63,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** 白板（Wild）：如意云纹 + 朱砂「百搭」印章——全盘最贵气的一张 */
function paintWild(ctx: CanvasRenderingContext2D, w: number, faceH: number) {
  ctx.save();
  // 云纹：三朵如意云（金，低透明度）
  ctx.strokeStyle = 'rgba(201,164,92,0.5)';
  ctx.lineWidth = Math.max(1.2, w * 0.022);
  const cloud = (cx: number, cy: number, s: number) => {
    ctx.beginPath();
    ctx.arc(cx - s * 0.8, cy, s * 0.5, Math.PI * 0.9, Math.PI * 1.9);
    ctx.arc(cx, cy - s * 0.35, s * 0.62, Math.PI * 1.05, Math.PI * 2.15);
    ctx.arc(cx + s * 0.8, cy, s * 0.5, Math.PI * 1.15, Math.PI * 0.35);
    ctx.stroke();
    // 云尾回勾
    ctx.beginPath();
    ctx.arc(cx + s * 1.1, cy + s * 0.28, s * 0.3, Math.PI * 1.2, Math.PI * 0.2, true);
    ctx.stroke();
  };
  cloud(w * 0.32, faceH * 0.24, w * 0.13);
  cloud(w * 0.72, faceH * 0.78, w * 0.11);

  // 朱砂印章
  const sw = w * 0.46;
  const sh = faceH * 0.52;
  const sx = (w - sw) / 2;
  const sy = (faceH - sh) / 2;
  roundRectPath(ctx, sx, sy, sw, sh, w * 0.05);
  const seal = ctx.createLinearGradient(sx, sy, sx, sy + sh);
  seal.addColorStop(0, COLORS.cinnabar500);
  seal.addColorStop(1, COLORS.cinnabar700);
  ctx.fillStyle = seal;
  ctx.fill();
  roundRectPath(ctx, sx + 1.5, sy + 1.5, sw - 3, sh - 3, w * 0.04);
  ctx.strokeStyle = 'rgba(251,247,236,0.8)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 竖排「百搭」
  ctx.fillStyle = COLORS.ivory100;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${sw * 0.44}px ${KAI_FONT}`;
  ctx.fillText('百', sx + sw / 2, sy + sh * 0.28);
  ctx.fillText('搭', sx + sw / 2, sy + sh * 0.72);
  ctx.restore();
}

function paintDice(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const half = size / 2;
  // 骰子体：带斜面高光
  roundRectPath(ctx, cx - half, cy - half, size, size, size * 0.22);
  const g = ctx.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.6, '#F2EFE6');
  g.addColorStop(1, '#DDD6C2');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(43,42,38,0.55)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  roundRectPath(ctx, cx - half + 1.5, cy - half + 1.5, size - 3, size - 3, size * 0.18);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const pip = size * 0.115;
  const off = size * 0.27;
  const dots: Array<[number, number, string]> = [
    [0, 0, COLORS.cinnabar500],
    [-off, -off, COLORS.ink900], [off, -off, COLORS.ink900],
    [-off, off, COLORS.ink900], [off, off, COLORS.ink900],
  ];
  for (const [dx, dy, color] of dots) {
    // 凹坑感：先暗环再点
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy + pip * 0.18, pip * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, pip, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** 牌面图集：key = 符号+倍数+宽度+状态 */
export class TileAtlas {
  private cache = new Map<string, HTMLCanvasElement>();
  dpr = Math.min(window.devicePixelRatio || 1, 3);

  get(cell: Cell, w: number, h: number, highlight: boolean): HTMLCanvasElement {
    const wi = Math.round(w);
    const hi = Math.round(h);
    const key = `${cell.symbol}|${cell.goldMultiplier ?? ''}|${wi}x${hi}|${highlight ? 'hl' : 'n'}`;
    let c = this.cache.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = wi * this.dpr;
      c.height = hi * this.dpr;
      const ctx = c.getContext('2d')!;
      ctx.scale(this.dpr, this.dpr);
      paintTile(ctx, cell, wi, hi, highlight);
      this.cache.set(key, c);
    }
    return c;
  }

  clear() { this.cache.clear(); }
}

export type { Cell };
