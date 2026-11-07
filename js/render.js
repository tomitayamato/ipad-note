// ページ・ストロークの描画（画面表示・サムネイル・PDF で共通）
export const PAGE_W = 1000;
export const PAGE_H = 1414; // A4 比率

export const PENS = {
  ballpoint: { label: 'ボールペン', widths: [2, 3.5, 6], pressure: true, alpha: 1 },
  magic: { label: 'マジックペン', widths: [6, 10, 16], pressure: false, alpha: 1 },
  marker: { label: 'マーカー', widths: [14, 24, 36], pressure: false, alpha: 0.35 },
};

export const COLORS = ['#1f1f1f', '#5f6368', '#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#8e44ad'];

export const PAPERS = { blank: '白紙', lined: '罫線', grid: '方眼' };

export function drawPaper(ctx, type) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.beginPath();
  if (type === 'lined') {
    ctx.strokeStyle = '#c5d3e6';
    ctx.lineWidth = 1.4;
    for (let y = 110; y < PAGE_H - 40; y += 44) {
      ctx.moveTo(40, y);
      ctx.lineTo(PAGE_W - 40, y);
    }
  } else if (type === 'grid') {
    ctx.strokeStyle = '#dde4ec';
    ctx.lineWidth = 1;
    const g = 40;
    const ox = (PAGE_W % g) / 2;
    const oy = (PAGE_H % g) / 2;
    for (let x = ox; x <= PAGE_W; x += g) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PAGE_H);
    }
    for (let y = oy; y <= PAGE_H; y += g) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_W, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function widthAt(s, p) {
  const q = Math.min(1, Math.max(0, p));
  return s.width * (0.35 + 1.3 * q);
}

export function drawStroke(ctx, s) {
  const pen = PENS[s.tool] || PENS.ballpoint;
  const pts = s.points;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (pen.alpha < 1) {
    ctx.globalAlpha = pen.alpha;
    ctx.globalCompositeOperation = 'multiply';
  }

  if (pts.length === 1) {
    const [x, y, p] = pts[0];
    const w = pen.pressure ? widthAt(s, p) : s.width;
    ctx.beginPath();
    ctx.arc(x, y, w / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (!pen.pressure) {
    // 一定幅：1本のパスで描く（マーカーの重なりで濃くならない）
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  } else {
    // 筆圧あり：区間ごとに太さを変える
    let px = pts[0][0];
    let py = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x, y, p] = pts[i];
      const nx = i < pts.length - 1 ? (x + pts[i + 1][0]) / 2 : x;
      const ny = i < pts.length - 1 ? (y + pts[i + 1][1]) / 2 : y;
      ctx.lineWidth = widthAt(s, p);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(x, y, nx, ny);
      ctx.stroke();
      px = nx;
      py = ny;
    }
  }
  ctx.restore();
}

export function renderPage(ctx, page) {
  drawPaper(ctx, page.paper);
  for (const s of page.strokes) drawStroke(ctx, s);
}

// 消しゴムの当たり判定
const bboxCache = new WeakMap();
function bbox(s) {
  let b = bboxCache.get(s);
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of s.points) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    b = [x0, y0, x1, y1];
    bboxCache.set(s, b);
  }
  return b;
}

function distSeg(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

export function hitStroke(s, x, y, r) {
  const rr = r + s.width / 2;
  const [x0, y0, x1, y1] = bbox(s);
  if (x < x0 - rr || x > x1 + rr || y < y0 - rr || y > y1 + rr) return false;
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= rr;
  for (let i = 1; i < pts.length; i++) {
    if (distSeg(x, y, pts[i - 1], pts[i]) <= rr) return true;
  }
  return false;
}
