// 麻将牌面绘制（CT-4 雅致国风）：象牙白牌面 + 底部厚度侧边 + 书法字
import type { Cell, SymbolId } from '@slots/engine';

export const COLORS = {
  felt900: '#142B22',
  felt700: '#1B3B2F',
  felt500: '#26523F',
  ivory100: '#FBF7EC',
  ivory300: '#F5EFE0',
  ivory500: '#E4D9C0',
  gold300: '#E3C98A',
  gold500: '#C9A45C',
  gold700: '#9A7B3F',
  cinnabar500: '#B33A3A',
  cinnabar700: '#8E2C2C',
  bamboo500: '#3E7C59',
  indigo500: '#35507A',
  ink900: '#2B2A26',
};

const GLYPHS: Record<string, { char: string; color: string }> = {
  zhong: { char: '中', color: COLORS.cinnabar500 },
  fa: { char: '發', color: COLORS.bamboo500 },
  east: { char: '東', color: COLORS.indigo500 },
  south: { char: '南', color: COLORS.indigo500 },
  west: { char: '西', color: COLORS.indigo500 },
  north: { char: '北', color: COLORS.indigo500 },
  wan: { char: '萬', color: COLORS.cinnabar500 },
  tong: { char: '筒', color: COLORS.indigo500 },
  tiao: { char: '條', color: COLORS.bamboo500 },
};

const FONT = '"LXGW WenKai", "Kaiti SC", KaiTi, STKaiti, "AR PL UKai CN", serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 画一张牌：w×h 内，含底部 8% 厚度侧边（CT-4 规格） */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  x: number, y: number, w: number, h: number,
  opts: { highlight?: boolean; alpha?: number; scale?: number } = {},
) {
  const { highlight = false, alpha = 1, scale = 1 } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (scale !== 1) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }
  const r = w * 0.12;
  const side = h * 0.08;
  const faceH = h - side;

  if (highlight) {
    ctx.shadowColor = COLORS.gold300;
    ctx.shadowBlur = w * 0.18;
  }

  // 底部侧边（厚度）
  roundRect(ctx, x, y + side, w, faceH, r);
  ctx.fillStyle = COLORS.ivory500;
  ctx.fill();
  ctx.shadowBlur = 0;

  // 牌面
  roundRect(ctx, x, y, w, faceH, r);
  const grad = ctx.createLinearGradient(x, y, x, y + faceH);
  const isGold = cell.symbol === 'gold';
  if (isGold) {
    grad.addColorStop(0, COLORS.gold300);
    grad.addColorStop(1, COLORS.gold500);
  } else {
    grad.addColorStop(0, highlight ? '#FFFDF5' : COLORS.ivory100);
    grad.addColorStop(1, highlight ? COLORS.ivory100 : COLORS.ivory300);
  }
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = highlight ? COLORS.gold500 : 'rgba(154,123,63,0.4)';
  ctx.lineWidth = highlight ? 2 : 1;
  ctx.stroke();

  // 牌面内容
  const cx = x + w / 2;
  const cy = y + faceH / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (cell.symbol === 'scatter') {
    drawDice(ctx, cx, cy, w * 0.62);
  } else if (isGold) {
    ctx.fillStyle = COLORS.cinnabar700;
    ctx.font = `bold ${w * 0.42}px ${FONT}`;
    ctx.fillText(`×${cell.goldMultiplier ?? ''}`, cx, cy);
  } else if (cell.symbol === 'wild') {
    // 白板：空牌面 + 淡金云纹框
    roundRect(ctx, x + w * 0.16, y + faceH * 0.14, w * 0.68, faceH * 0.72, r * 0.6);
    ctx.strokeStyle = COLORS.gold500;
    ctx.lineWidth = Math.max(1.5, w * 0.03);
    ctx.stroke();
    ctx.fillStyle = COLORS.gold500;
    ctx.font = `${w * 0.2}px ${FONT}`;
    ctx.fillText('百搭', cx, cy);
  } else {
    const g = GLYPHS[cell.symbol];
    if (g) {
      ctx.fillStyle = g.color;
      ctx.font = `bold ${w * 0.52}px ${FONT}`;
      ctx.fillText(g.char, cx, cy);
    }
  }
  ctx.restore();
}

function drawDice(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const half = size / 2;
  roundRect(ctx, cx - half, cy - half, size, size, size * 0.2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = COLORS.ink900;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // 五点骰面（中心红点）
  const pip = size * 0.11;
  const off = size * 0.26;
  const dots: Array<[number, number, string]> = [
    [0, 0, COLORS.cinnabar500],
    [-off, -off, COLORS.ink900], [off, -off, COLORS.ink900],
    [-off, off, COLORS.ink900], [off, off, COLORS.ink900],
  ];
  for (const [dx, dy, color] of dots) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, pip, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

export type { Cell, SymbolId };
