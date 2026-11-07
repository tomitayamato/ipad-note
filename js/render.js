// ページ・ストロークの描画（画面表示・サムネイル・PDF で共通）
export const PAGE_W = 1000;
export const PAGE_H = 1414; // A4 比率

// 太さはページ座標（ページ幅 = 1000）での値
export const PENS = {
  ballpoint: { label: 'ボールペン', min: 1, max: 12, def: 3.5, pressure: true, alpha: 1 },
  magic: { label: 'マジックペン', min: 4, max: 30, def: 10, pressure: false, alpha: 1 },
  marker: { label: 'マーカー', min: 10, max: 60, def: 24, pressure: false, alpha: 0.35 },
};

export const ERASER = { min: 6, max: 120, def: 30 };
const ERASER_STYLE = { pressure: false, alpha: 1 };

// 基本の8色（黒・赤・青・緑・黄・オレンジ・紫・白）。ペンの設定で自由に編集できる
export const COLORS = ['#1f1f1f', '#d93025', '#1a73e8', '#188038', '#f9ab00', '#e8710a', '#8e44ad', '#ffffff'];

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
  const isEraser = s.tool === 'eraser';
  const pen = isEraser ? ERASER_STYLE : PENS[s.tool] || PENS.ballpoint;
  const pts = s.points;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (isEraser) {
    // 消しゴム：インク層を丸いブラシで削る（本物の消しゴムのように部分的に消える）
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = ctx.fillStyle = '#000';
    ctx.lineWidth = s.width;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
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

// 線はインク層（透明なキャンバス）に描いてから用紙に重ねる。
// こうすると消しゴム（destination-out）が用紙の罫線を消さずに線だけを消せる。
let scratch = null;
export function drawInk(ctx, strokes) {
  for (const s of strokes) drawStroke(ctx, s);
}

/* ---------- 貼り付けた画像（用紙とインクの間に描く：画像の上から書き込める） ---------- */
const imgCache = new Map(); // item.id -> HTMLImageElement
let onImageLoad = null;
export function setImageLoadHandler(fn) {
  onImageLoad = fn;
}

function getImage(item) {
  let im = imgCache.get(item.id);
  if (!im) {
    im = new Image();
    im.addEventListener('load', () => onImageLoad && onImageLoad());
    im.src = item.src;
    imgCache.set(item.id, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

export function drawImages(ctx, page) {
  for (const it of page.images || []) {
    const im = getImage(it);
    if (im) {
      ctx.drawImage(im, it.x, it.y, it.w, it.h);
    } else {
      ctx.save();
      ctx.fillStyle = '#f1eee9';
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.restore();
    }
  }
}

// PDF・サムネイル用：画像の読み込みを待つ
export function preloadImages(pages) {
  const waits = [];
  for (const p of pages) {
    for (const it of p.images || []) {
      getImage(it);
      const im = imgCache.get(it.id);
      if (!im.complete) {
        waits.push(new Promise((r) => {
          im.addEventListener('load', r, { once: true });
          im.addEventListener('error', r, { once: true });
        }));
      }
    }
  }
  return Promise.all(waits);
}

export function renderPage(ctx, page) {
  drawPaper(ctx, page.paper);
  drawImages(ctx, page);
  const { width, height } = ctx.canvas;
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const ictx = scratch.getContext('2d');
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, width, height);
  ictx.setTransform(ctx.getTransform());
  drawInk(ictx, page.strokes);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}
