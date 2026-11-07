// ノート編集画面：描画・ジェスチャー・ページ操作・画像・ペン設定
import { db, uid } from './db.js';
import {
  PAGE_W, PAGE_H, PENS, ERASER, COLORS, PAPERS,
  renderPage, drawPaper, drawInk, drawStroke, drawImages, setImageLoadHandler, preloadImages,
} from './render.js';
import { recognizeShape } from './shapes.js';
import { $, el, showMenu, toast, confirmDialog } from './ui.js';
import { settings, saveSettings, currentPen } from './settings.js';

const stage = $('#stage');
const base = $('#base-canvas');
const live = $('#live-canvas');
const bctx = base.getContext('2d');
const lctx = live.getContext('2d');
const ink = document.createElement('canvas'); // 線だけの層（消しゴムで削る対象）
const ictx = ink.getContext('2d');
const pagesPanel = $('#pages-panel');
const penPanel = $('#pen-panel');
const flipLayer = $('#flip-layer');
const imgEdit = $('#img-edit');

let nb = null;
let pages = [];
let cur = 0;
let hooks = {};
let isOpen = false;

// 表示：s = 倍率、rot = 紙の角度（度）、cx/cy = 紙の中心の画面上の位置
const view = { fit: 1, s: 1, zoom: 1, rot: 0, cx: 0, cy: 0 };
let W = 0, H = 0, dpr = 1;
let stageRect = null;

let tool = 'pen'; // 'pen' | 'eraser'
let lastInputType = null;

const history = new Map(); // pageId -> { undo: [], redo: [] }
const dirtyPages = new Set();
let saveTimer = null;

setImageLoadHandler(() => {
  if (isOpen) scheduleRedraw();
});

/* ================= 開く・閉じる ================= */
export async function openEditor(notebook, opts) {
  nb = notebook;
  hooks = opts;
  const list = await db.pagesOf(nb.id);
  const byId = new Map(list.map((p) => [p.id, p]));
  pages = nb.pageIds.map((id) => byId.get(id)).filter(Boolean);
  if (!pages.length) {
    const p = newPage('blank');
    pages = [p];
    await db.put('pages', p);
  }
  for (const p of pages) if (!p.images) p.images = [];
  nb.pageIds = pages.map((p) => p.id);
  cur = Math.min(Math.max(0, nb.lastPage || 0), pages.length - 1);
  history.clear();
  tool = 'pen';
  isOpen = true;
  $('#nb-title').textContent = nb.name;
  closePanels();
  view.rot = 0;
  resize();
  resetView();
  redraw();
  updateUI();
}

export async function closeEditor() {
  if (stroke) endDraw();
  finishImageEdit();
  cancelFlipNow();
  closePanels();
  await flush();
  isOpen = false;
  nb = null;
  pages = [];
}

function newPage(paper) {
  return { id: uid(), notebookId: nb.id, paper, strokes: [], images: [], createdAt: Date.now() };
}

/* ================= 保存（自動） ================= */
function markDirty(page = pages[cur]) {
  dirtyPages.add(page);
  nb.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!nb) return;
  const list = [...dirtyPages];
  dirtyPages.clear();
  try {
    for (const p of list) await db.put('pages', p);
    await db.put('notebooks', nb);
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', () => flush());

/* ================= 表示（拡大・移動） ================= */
function resize() {
  const r = stage.getBoundingClientRect();
  W = r.width;
  H = r.height;
  dpr = window.devicePixelRatio || 1;
  for (const c of [base, live, ink]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  for (const c of [base, live]) {
    c.style.width = W + 'px';
    c.style.height = H + 'px';
  }
  view.fit = fitFor(view.rot);
}

// 傾けた紙の外枠（画面上の幅・高さ）
function boundsFor(rot, scale) {
  const r = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const sn = Math.abs(Math.sin(r));
  return [(PAGE_W * c + PAGE_H * sn) * scale, (PAGE_W * sn + PAGE_H * c) * scale];
}

// その角度で紙全体が画面に収まる倍率
function fitFor(rot) {
  const [bw, bh] = boundsFor(rot, 1);
  return Math.min((W - 28) / bw, (H - 28) / bh);
}

function resetView() {
  view.fit = fitFor(view.rot);
  view.zoom = 1;
  view.s = view.fit;
  view.cx = W / 2;
  view.cy = H / 2;
}

function clampView() {
  const [bw, bh] = boundsFor(view.rot, view.s);
  const m = 60;
  view.cx = bw <= W ? W / 2 : Math.min(m + bw / 2, Math.max(W - m - bw / 2, view.cx));
  view.cy = bh <= H ? H / 2 : Math.min(m + bh / 2, Math.max(H - m - bh / 2, view.cy));
}

// ページ座標 → 画面座標 の変換行列
function matrix() {
  const r = (view.rot * Math.PI) / 180;
  const a = view.s * Math.cos(r);
  const b = view.s * Math.sin(r);
  return { a, b, c: -b, d: a, e: view.cx - (a * PAGE_W) / 2 + (b * PAGE_H) / 2, f: view.cy - (b * PAGE_W) / 2 - (a * PAGE_H) / 2 };
}

function toScreen(x, y) {
  const m = matrix();
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function toPageXY(sx, sy) {
  const r = (view.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const vx = (sx - view.cx) / view.s;
  const vy = (sy - view.cy) / view.s;
  return [cos * vx + sin * vy + PAGE_W / 2, -sin * vx + cos * vy + PAGE_H / 2];
}

function applyT(ctx) {
  const m = matrix();
  ctx.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * m.e, dpr * m.f);
}

function clipPage(ctx) {
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
}

// インク層を作り直す（ページ切替・拡大・元に戻すなど）
function renderInk() {
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, ink.width, ink.height);
  if (!pages[cur]) return;
  applyT(ictx);
  drawInk(ictx, pages[cur].strokes);
}

// 背景＋用紙＋画像＋インク層を画面に合成
function composite() {
  if (!pages[cur]) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = '#e9e6e1';
  bctx.fillRect(0, 0, base.width, base.height);
  applyT(bctx);
  bctx.save();
  bctx.shadowColor = 'rgba(0,0,0,0.18)';
  bctx.shadowBlur = 14 * dpr;
  bctx.shadowOffsetY = 2 * dpr;
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, PAGE_W, PAGE_H);
  bctx.restore();
  bctx.save();
  clipPage(bctx);
  drawPaper(bctx, pages[cur].paper);
  drawImages(bctx, pages[cur]);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.drawImage(ink, 0, 0);
  bctx.restore();
  positionImageEdit();
}

function redraw() {
  renderInk();
  composite();
  renderLive();
}

let redrawQueued = false;
function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    redraw();
  });
}

let compositeQueued = false;
function scheduleComposite() {
  if (compositeQueued) return;
  compositeQueued = true;
  requestAnimationFrame(() => {
    compositeQueued = false;
    composite();
  });
}

let liveQueued = false;
function scheduleLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    renderLive();
  });
}

function renderLive() {
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, live.width, live.height);
  if (!stroke) return;
  applyT(lctx);
  if (stroke.tool === 'eraser') {
    const [x, y] = stroke.points[stroke.points.length - 1];
    lctx.beginPath();
    lctx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
    lctx.lineWidth = 1.5 / view.s;
    lctx.strokeStyle = 'rgba(80,80,80,0.8)';
    lctx.fillStyle = 'rgba(255,255,255,0.35)';
    lctx.fill();
    lctx.stroke();
    return;
  }
  lctx.save();
  clipPage(lctx);
  drawStroke(lctx, stroke);
  lctx.restore();
}

// 画面サイズが変わったら作り直す。iOSの resize イベントはレイアウト確定前に来ることがあり、
// 古いサイズで中央を計算するとページが横にずれたままになるため、ResizeObserver で確定後のサイズを使う。
function onStageResize() {
  if (!isOpen) return;
  const r = stage.getBoundingClientRect();
  if (Math.abs(r.width - W) < 1 && Math.abs(r.height - H) < 1) return;
  cancelFlipNow();
  resize();
  resetView();
  redraw();
}
if ('ResizeObserver' in window) new ResizeObserver(onStageResize).observe(stage);
window.addEventListener('resize', () => requestAnimationFrame(onStageResize));
window.addEventListener('orientationchange', () => setTimeout(onStageResize, 300));

/* ================= 描画 ================= */
let stroke = null; // 描いている途中の線（ペン or 消しゴム）
let drawPointerId = null;
let drawPointerType = null;
let holdTimer = null;
let holdAnchor = null;

function toPage(e) {
  return toPageXY(e.clientX - stageRect.left, e.clientY - stageRect.top);
}

function pressureOf(e) {
  if (e.pointerType !== 'pen') return 0.5;
  return e.pressure > 0 ? e.pressure : 0.5;
}

const r2 = (v) => Math.round(v * 100) / 100;

function eraseSegment(a, b, width) {
  applyT(ictx);
  ictx.save();
  ictx.globalCompositeOperation = 'destination-out';
  ictx.fillStyle = ictx.strokeStyle = '#000';
  ictx.lineCap = 'round';
  ictx.lineWidth = width;
  ictx.beginPath();
  if (a === b) {
    ictx.arc(a[0], a[1], width / 2, 0, Math.PI * 2);
    ictx.fill();
  } else {
    ictx.moveTo(a[0], a[1]);
    ictx.lineTo(b[0], b[1]);
    ictx.stroke();
  }
  ictx.restore();
}

function beginDraw(e) {
  const [x, y] = toPage(e);
  if (tool === 'eraser') {
    stroke = { tool: 'eraser', width: settings.eraserWidth, points: [[r2(x), r2(y)]] };
    eraseSegment(stroke.points[0], stroke.points[0], stroke.width);
    scheduleComposite();
    scheduleLive();
    return;
  }
  const pen = currentPen();
  stroke = { tool: pen.type, color: pen.color, width: pen.width, points: [[r2(x), r2(y), r2(pressureOf(e))]] };
  holdAnchor = [x, y];
  scheduleLive();
}

// 書き終わりでペンを止めると図形に補正
function trySnapShape() {
  holdTimer = null;
  if (!stroke || stroke.tool === 'eraser' || stroke.snapped || !settings.shapeSnap) return;
  const pts = recognizeShape(stroke.points);
  if (!pts) return;
  stroke.points = pts;
  stroke.snapped = true;
  scheduleLive();
}

function moveDraw(e) {
  if (!stroke || stroke.snapped) return;
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const ev of evs.length ? evs : [e]) {
    const [x, y] = toPage(ev);
    const last = stroke.points[stroke.points.length - 1];
    if (stroke.tool !== 'eraser' && Math.hypot(x - holdAnchor[0], y - holdAnchor[1]) > 3) {
      holdAnchor = [x, y];
      clearTimeout(holdTimer);
      holdTimer = setTimeout(trySnapShape, 550);
    }
    if (Math.hypot(x - last[0], y - last[1]) < 0.5) continue;
    if (stroke.tool === 'eraser') {
      const p = [r2(x), r2(y)];
      stroke.points.push(p);
      eraseSegment(last, p, stroke.width);
    } else {
      const p = last[2] * 0.6 + pressureOf(ev) * 0.4;
      stroke.points.push([r2(x), r2(y), r2(p)]);
    }
  }
  if (stroke.tool === 'eraser') scheduleComposite();
  scheduleLive();
}

// 線を確定する（キャンセルされた場合も、描いた分は残す）
function endDraw() {
  clearTimeout(holdTimer);
  drawPointerId = null;
  drawPointerType = null;
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  delete s.snapped;
  pages[cur].strokes.push(s);
  pushHistory({ type: 'add', stroke: s });
  if (s.tool !== 'eraser') {
    applyT(ictx);
    drawStroke(ictx, s);
  }
  composite();
  renderLive();
  markDirty();
  if (needSettle && !touches.size) settleView();
}

function abortDraw() {
  clearTimeout(holdTimer);
  const wasEraser = stroke && stroke.tool === 'eraser';
  stroke = null;
  drawPointerId = null;
  drawPointerType = null;
  if (wasEraser) redraw();
  else renderLive();
}

/* ================= 元に戻す・やり直す・全消し ================= */
function hist() {
  const id = pages[cur].id;
  if (!history.has(id)) history.set(id, { undo: [], redo: [] });
  return history.get(id);
}

function pushHistory(op) {
  const h = hist();
  h.undo.push(op);
  if (h.undo.length > 300) h.undo.shift();
  h.redo.length = 0;
  updateUI();
}

const rectOf = (it) => ({ x: it.x, y: it.y, w: it.w, h: it.h });

function revert(op) {
  const page = pages[cur];
  switch (op.type) {
    case 'add': {
      const i = page.strokes.lastIndexOf(op.stroke);
      if (i >= 0) page.strokes.splice(i, 1);
      break;
    }
    case 'clear':
      page.strokes = op.prev;
      page.images = op.prevImages;
      break;
    case 'img-add':
      page.images = page.images.filter((x) => x !== op.item);
      break;
    case 'img-del':
      page.images.splice(Math.min(op.index, page.images.length), 0, op.item);
      break;
    case 'img-move':
      Object.assign(op.item, op.from);
      break;
  }
}

function reapply(op) {
  const page = pages[cur];
  switch (op.type) {
    case 'add':
      page.strokes.push(op.stroke);
      break;
    case 'clear':
      page.strokes = [];
      page.images = [];
      break;
    case 'img-add':
      page.images.push(op.item);
      break;
    case 'img-del':
      page.images = page.images.filter((x) => x !== op.item);
      break;
    case 'img-move':
      Object.assign(op.item, op.to);
      break;
  }
}

function undo() {
  if (stroke) return false;
  finishImageEdit();
  const h = hist();
  const op = h.undo.pop();
  if (!op) return false;
  revert(op);
  h.redo.push(op);
  redraw();
  markDirty();
  updateUI();
  return true;
}

function redo() {
  if (stroke) return false;
  finishImageEdit();
  const h = hist();
  const op = h.redo.pop();
  if (!op) return false;
  reapply(op);
  h.undo.push(op);
  redraw();
  markDirty();
  updateUI();
  return true;
}

async function clearPage() {
  const page = pages[cur];
  if (!page.strokes.length && !page.images.length) return toast('このページには何も書かれていません');
  closePanels();
  finishImageEdit();
  const ok = await confirmDialog('このページに書いた内容と貼り付けた画像をすべて消しますか？\n（元に戻すボタンで戻せます）', '全消し', true);
  if (!ok) return;
  pushHistory({ type: 'clear', prev: page.strokes, prevImages: page.images });
  page.strokes = [];
  page.images = [];
  redraw();
  markDirty();
}

/* ================= 写真・スクショの貼り付け ================= */
const imageInput = $('#image-input');

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      resolve(im);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    im.src = url;
  });
}

async function insertImageBlob(blob) {
  let im;
  try {
    im = await loadImage(blob);
  } catch (e) {
    return toast('この画像は読み込めませんでした');
  }
  // 端末の容量を圧迫しないよう、長辺1600pxに縮小してJPEGで保存
  const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k);
  c.height = Math.round(im.naturalHeight * k);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(im, 0, 0, c.width, c.height);
  const src = c.toDataURL('image/jpeg', 0.85);

  const fit = Math.min((PAGE_W * 0.8) / c.width, (PAGE_H * 0.55) / c.height);
  const w = c.width * fit;
  const h = c.height * fit;
  // いま見えている範囲の中央に置く
  const [pcx, pcy] = toPageXY(W / 2, H / 2);
  const cx = Math.min(PAGE_W - w / 2, Math.max(w / 2, pcx));
  const cy = Math.min(PAGE_H - h / 2, Math.max(h / 2, pcy));
  const item = { id: uid(), src, x: r2(cx - w / 2), y: r2(cy - h / 2), w: r2(w), h: r2(h) };
  pages[cur].images.push(item);
  pushHistory({ type: 'img-add', item });
  markDirty();
  composite();
  startImageEdit(item);
}

function pickPhoto() {
  closePanels();
  imageInput.click();
}

imageInput.addEventListener('change', () => {
  const f = imageInput.files[0];
  imageInput.value = '';
  if (f) insertImageBlob(f);
});

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) return insertImageBlob(await it.getType(type));
    }
    toast('クリップボードに画像がありません');
  } catch (e) {
    toast('クリップボードを読み取れませんでした');
  }
}

document.addEventListener('paste', (e) => {
  if (!isOpen || !e.clipboardData) return;
  const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
  if (f) {
    e.preventDefault();
    insertImageBlob(f);
  }
});

function imageAt(px, py) {
  const list = pages[cur].images;
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (px >= it.x && px <= it.x + it.w && py >= it.y && py <= it.y + it.h) return it;
  }
  return null;
}

function deleteImage(item) {
  const page = pages[cur];
  const index = page.images.indexOf(item);
  if (index < 0) return;
  if (editItem === item) {
    editItem = null;
    imgEdit.classList.add('hidden');
  }
  page.images.splice(index, 1);
  pushHistory({ type: 'img-del', item, index });
  markDirty();
  composite();
}

/* --- 画像の移動・拡大縮小 --- */
let editItem = null;
let editFrom = null;
let imgDrag = null;

function startImageEdit(item) {
  closePanels();
  editItem = item;
  editFrom = rectOf(item);
  imgEdit.classList.remove('hidden');
  positionImageEdit();
}

function positionImageEdit() {
  if (!editItem) return;
  const f = $('.img-frame', imgEdit);
  const [sx, sy] = toScreen(editItem.x + editItem.w / 2, editItem.y + editItem.h / 2);
  const w = editItem.w * view.s;
  const h = editItem.h * view.s;
  Object.assign(f.style, {
    left: sx - w / 2 + 'px', top: sy - h / 2 + 'px', width: w + 'px', height: h + 'px',
    transform: `rotate(${view.rot}deg)`,
  });
  // 傾いている時は外枠の高さでボタンの位置を決める
  const rr = (view.rot * Math.PI) / 180;
  const bh = Math.abs(w * Math.sin(rr)) + Math.abs(h * Math.cos(rr));
  const tools = $('.img-tools', imgEdit);
  const top = sy - bh / 2;
  const above = top - 52 > 6;
  Object.assign(tools.style, {
    left: Math.max(8, Math.min(W - 170, sx - 80)) + 'px',
    top: (above ? top - 52 : Math.min(H - 52, sy + bh / 2 + 10)) + 'px',
  });
}

function finishImageEdit() {
  if (!editItem) return;
  const item = editItem;
  editItem = null;
  imgEdit.classList.add('hidden');
  const to = rectOf(item);
  if (JSON.stringify(to) !== JSON.stringify(editFrom)) {
    pushHistory({ type: 'img-move', item, from: editFrom, to });
    markDirty();
  }
}

const frame = $('.img-frame', imgEdit);
frame.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  if (!editItem) return;
  try {
    frame.setPointerCapture(e.pointerId);
  } catch (_) {}
  imgDrag = { mode: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, r0: rectOf(editItem), id: e.pointerId };
});
frame.addEventListener('pointermove', (e) => {
  if (!imgDrag || e.pointerId !== imgDrag.id) return;
  // 画面上の動きを、紙の向きに合わせた動きに直す
  const r = (view.rot * Math.PI) / 180;
  const ex = e.clientX - imgDrag.sx;
  const ey = e.clientY - imgDrag.sy;
  const dx = (Math.cos(r) * ex + Math.sin(r) * ey) / view.s;
  const dy = (-Math.sin(r) * ex + Math.cos(r) * ey) / view.s;
  const r0 = imgDrag.r0;
  const ratio = r0.h / r0.w;
  const it = editItem;
  const minW = 40;
  switch (imgDrag.mode) {
    case 'move':
      it.x = r2(r0.x + dx);
      it.y = r2(r0.y + dy);
      break;
    case 'br':
      it.w = Math.max(minW, r0.w + dx);
      break;
    case 'tr':
      it.w = Math.max(minW, r0.w + dx);
      break;
    case 'bl':
      it.w = Math.max(minW, r0.w - dx);
      break;
    case 'tl':
      it.w = Math.max(minW, r0.w - dx);
      break;
  }
  if (imgDrag.mode !== 'move') {
    it.h = it.w * ratio;
    it.x = imgDrag.mode.endsWith('l') ? r0.x + r0.w - it.w : r0.x;
    it.y = imgDrag.mode.startsWith('t') ? r0.y + r0.h - it.h : r0.y;
    it.w = r2(it.w); it.h = r2(it.h); it.x = r2(it.x); it.y = r2(it.y);
  }
  scheduleComposite();
});
const endImgDrag = () => {
  imgDrag = null;
};
frame.addEventListener('pointerup', endImgDrag);
frame.addEventListener('pointercancel', endImgDrag);
for (const type of ['touchstart', 'touchmove']) {
  imgEdit.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
$('#img-done').addEventListener('click', finishImageEdit);
$('#img-del').addEventListener('click', () => editItem && deleteImage(editItem));

/* ================= 紙のようなページめくり ================= */
let flip = null;

function snapshot(page) {
  const c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * view.s * dpr);
  c.height = Math.round(PAGE_H * view.s * dpr);
  const x = c.getContext('2d');
  const k = c.width / PAGE_W;
  x.setTransform(k, 0, 0, k, 0, 0);
  renderPage(x, page);
  c.className = 'flip-canvas';
  return c;
}

// dir: +1 = 次へ / -1 = 前へ。めくれるページが無ければ null
function startFlip(dir) {
  if (flip || view.rot !== 0) return null; // 紙を傾けている時はめくりアニメーションなし
  let target = null;
  let virtual = false;
  if (dir > 0) {
    if (cur < pages.length - 1) target = pages[cur + 1];
    else if (pages[cur].strokes.length || pages[cur].images.length) {
      target = { paper: pages[cur].paper, strokes: [], images: [] }; // 新しいページ（めくり終えたら追加）
      virtual = true;
    }
  } else if (cur > 0) {
    target = pages[cur - 1];
  }
  if (!target) return null;
  if (stroke) endDraw();
  finishImageEdit();
  resetView();
  composite();

  const sw = PAGE_W * view.s;
  const sh = PAGE_H * view.s;
  flipLayer.innerHTML = '';
  Object.assign(flipLayer.style, { left: view.cx - sw / 2 + 'px', top: view.cy - sh / 2 + 'px', width: sw + 'px', height: sh + 'px' });

  // 下の紙：次へ = めくった先のページ / 前へ = 今のページ
  const underShade = el('div', { class: 'flip-under-shade' });
  const under = el('div', { class: 'flip-under' }, [snapshot(dir > 0 ? target : pages[cur]), underShade]);
  // めくれる紙：次へ = 今のページ / 前へ = 前のページ（左側から戻ってくる）
  const frontShade = el('div', { class: 'flip-shade' });
  const backShade = el('div', { class: 'flip-shade' });
  const front = el('div', { class: 'flip-face front' }, [snapshot(dir > 0 ? pages[cur] : target), frontShade]);
  const back = el('div', { class: 'flip-face back' }, [backShade]);
  const leaf = el('div', { class: 'flip-leaf' }, [front, back]);
  flipLayer.append(under, leaf);
  flipLayer.classList.remove('hidden', 'animating');
  flip = { dir, virtual, leaf, frontShade, backShade, underShade, p: 0 };
  setFlip(0);
  return flip;
}

function setFlip(p) {
  const f = flip;
  f.p = p;
  const ang = f.dir > 0 ? -180 * p : -180 * (1 - p); // 0 = 閉じている / -180 = 左にめくり切った
  const t = Math.abs(ang) / 180;
  f.leaf.style.transform = `rotateY(${ang}deg)`;
  f.frontShade.style.opacity = (t * 0.55).toFixed(3); // めくれるほど表面が暗く
  f.backShade.style.opacity = ((1 - t) * 0.45).toFixed(3);
  f.underShade.style.opacity = (Math.sin(t * Math.PI) * 0.45).toFixed(3); // 下の紙に落ちる影
}

function finishFlip(commit, ms = 320) {
  const f = flip;
  if (!f || f.finishing) return;
  f.finishing = true;
  flipLayer.style.setProperty('--flip-ms', ms + 'ms');
  void flipLayer.offsetWidth;
  flipLayer.classList.add('animating');
  setFlip(commit ? 1 : 0);
  setTimeout(async () => {
    if (commit) {
      let idx = cur + f.dir;
      if (f.virtual) idx = await addPage();
      goTo(idx);
      if (f.virtual) toast('新しいページを追加しました');
    }
    cancelFlipNow();
  }, ms + 30);
}

function cancelFlipNow() {
  flip = null;
  flipLayer.classList.add('hidden');
  flipLayer.classList.remove('animating');
  flipLayer.innerHTML = '';
}

async function turnPage(dir) {
  if (flip) return;
  if (view.rot === 0) {
    if (startFlip(dir)) return finishFlip(true, 520);
  } else if (dir > 0) {
    // 傾けている時はアニメーションなしでページを切り替える
    if (cur < pages.length - 1) return goTo(cur + 1);
    if (pages[cur].strokes.length || pages[cur].images.length) {
      goTo(await addPage());
      return toast('新しいページを追加しました');
    }
  } else if (cur > 0) {
    return goTo(cur - 1);
  }
  if (dir > 0) toast('最後のページです');
}

const nextPage = () => turnPage(1);
const prevPage = () => turnPage(-1);

function resetRotation() {
  view.rot = 0;
  resetView();
  redraw();
}

/* ================= ポインター（ペン・指・マウス） ================= */
const touches = new Map();
let gesture = null;
let lpTimer = null;
let tap = null; // 2本指・3本指タップの判定

const pt = (e) => ({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const angleOf = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const norm180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const SNAP = 8; // 上下左右（0°・90°・180°・270°）に吸い付く範囲

function capture(e) {
  try {
    stage.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 対象のポインターが既に無い場合など */
  }
}

function canDraw(e) {
  return e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && settings.fingerDraw);
}

function cancelTouchGesture() {
  clearTimeout(lpTimer);
  tap = null;
  if (touches.size) {
    gesture = { type: 'none' };
    needSettle = true; // ピンチ等の途中でペンを置いた：あとで表示を整える
  }
}

// 回転中に角度を表示
let angleTimer = null;
function showAngle(rot) {
  const badge = $('#angle-badge');
  const deg = Math.round(rot > 180 ? rot - 360 : rot);
  badge.textContent = `${deg}°`;
  badge.classList.toggle('snapped', rot % 90 === 0);
  badge.classList.remove('hidden');
  clearTimeout(angleTimer);
  angleTimer = setTimeout(() => badge.classList.add('hidden'), 900);
}

// 拡大率・位置を正しい範囲に戻す（ほぼ等倍なら中央に戻す）
let needSettle = false;
function settleView() {
  needSettle = false;
  if (view.zoom < 1.03) resetView();
  else clampView();
  redraw();
}

function trackTap(id, p) {
  if (!tap) tap = { t0: performance.now(), starts: new Map(), max: 0, ok: true };
  tap.starts.set(id, p);
  tap.max = Math.max(tap.max, touches.size);
}

function startGesture({ allowSwipe = true } = {}) {
  clearTimeout(lpTimer);
  const pts = [...touches.values()];
  if (pts.length === 1) {
    const p = pts[0];
    gesture = {
      type: 'one', sx: p.x, sy: p.y, t: performance.now(),
      cx0: view.cx, cy0: view.cy, moved: false, allowSwipe, flipTried: false, flip: null,
    };
    if (allowSwipe) {
      lpTimer = setTimeout(() => {
        if (gesture && gesture.type === 'one' && !gesture.moved) {
          gesture = { type: 'none' };
          tap = null;
          openPageMenu(stageRect.left + p.x, stageRect.top + p.y);
        }
      }, 550);
    }
  } else if (pts.length >= 2) {
    if (gesture && gesture.flip) finishFlip(false);
    const [a, b] = pts;
    gesture = {
      type: 'pinch', d0: dist(a, b) || 1, m0: mid(a, b), a0: angleOf(a, b),
      s0: view.s, z0: view.zoom, rot0: view.rot, cx0: view.cx, cy0: view.cy, rotated: false,
    };
  }
}

// iOS の標準ジェスチャー（ダブルタップ判定・拡大鏡など）を止める。
for (const type of ['touchstart', 'touchmove', 'touchend']) {
  stage.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openPageMenu(e.clientX, e.clientY);
});

stage.addEventListener('pointerdown', (e) => {
  if (flip) return;
  if (editItem) {
    finishImageEdit();
    return;
  }
  if (panelsOpen()) {
    closePanels();
    if (e.pointerType !== 'pen') return; // ペンならそのまま書き始める
  }
  stageRect = stage.getBoundingClientRect();
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  lastInputType = e.pointerType;

  // 取りこぼした「離した」イベントの後始末（速い連続タップ対策）
  if (e.isPrimary) {
    if (drawPointerId !== null && drawPointerType === e.pointerType) endDraw();
    if (e.pointerType === 'touch' && touches.size) {
      touches.clear();
      gesture = null;
      tap = null;
      clearTimeout(lpTimer);
    }
  }
  if (e.pointerType === 'pen') cancelTouchGesture();

  if (drawPointerId === null && canDraw(e) && !(e.pointerType === 'touch' && touches.size > 0)) {
    capture(e);
    drawPointerId = e.pointerId;
    drawPointerType = e.pointerType;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, pt(e));
      tap = null;
      trackTap(e.pointerId, pt(e));
    }
    beginDraw(e);
    return;
  }

  if (e.pointerType === 'touch') {
    if (drawPointerId !== null && drawPointerType === 'pen') return; // 手のひらは無視
    if (drawPointerId !== null && drawPointerType === 'touch') abortDraw(); // 2本目の指 → ピンチへ
    touches.set(e.pointerId, pt(e));
    trackTap(e.pointerId, pt(e));
    capture(e);
    startGesture();
  }
});

stage.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && tap && tap.starts.has(e.pointerId)) {
    if (dist(pt(e), tap.starts.get(e.pointerId)) > 14) tap.ok = false;
  }
  if (e.pointerId === drawPointerId) {
    if (drawPointerType === 'touch') touches.set(e.pointerId, pt(e));
    moveDraw(e);
    return;
  }
  if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
  touches.set(e.pointerId, pt(e));
  if (!gesture) return;

  if (gesture.type === 'one') {
    const p = pt(e);
    const dx = p.x - gesture.sx;
    const dy = p.y - gesture.sy;
    if (Math.hypot(dx, dy) > 10) {
      gesture.moved = true;
      clearTimeout(lpTimer);
    }
    if (!gesture.moved) return;
    if (view.zoom > 1.01) {
      view.cx = gesture.cx0 + dx;
      view.cy = gesture.cy0 + dy;
      clampView();
      scheduleRedraw();
    } else if (gesture.allowSwipe) {
      if (!gesture.flipTried && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        gesture.flipTried = true;
        gesture.flip = startFlip(dx < 0 ? 1 : -1);
      }
      if (gesture.flip) {
        // めくれる紙の端が指先についてくるように角度を決める
        const pw = PAGE_W * view.s;
        const c = Math.max(-1, Math.min(1, gesture.flip.dir > 0 ? 1 + dx / pw : -1 + (2.2 * dx) / pw));
        const a = Math.acos(c) / Math.PI;
        setFlip(gesture.flip.dir > 0 ? a : 1 - a);
      } else if (gesture.flipTried) {
        view.cx = gesture.cx0 + dx * 0.25; // めくれない時は少しだけ動いて戻る
        scheduleRedraw();
      }
    }
  } else if (gesture.type === 'pinch' && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const m = mid(a, b);
    // 回転：2本指のひねった角度だけ紙を回す。上下左右の近くでは吸い付く
    let rot = gesture.rot0 + norm180(angleOf(a, b) - gesture.a0);
    const snapped = Math.round(rot / 90) * 90;
    if (Math.abs(rot - snapped) < SNAP) rot = snapped;
    rot = ((rot % 360) + 360) % 360;
    if (rot !== gesture.rot0) gesture.rotated = true;
    view.rot = rot;
    view.fit = fitFor(rot);
    // 拡大縮小（「画面に収まる大きさ」に対する倍率で考える：回しても紙が画面からはみ出さない）
    const s = view.fit * Math.min(5, Math.max(0.8, (gesture.z0 * dist(a, b)) / gesture.d0));
    // 指の間の点が、つまんだ時と同じ紙の位置に来るように中心を動かす
    const dr = ((rot - gesture.rot0) * Math.PI) / 180;
    const k = s / gesture.s0;
    const vx = gesture.cx0 - gesture.m0.x;
    const vy = gesture.cy0 - gesture.m0.y;
    view.cx = m.x + k * (Math.cos(dr) * vx - Math.sin(dr) * vy);
    view.cy = m.y + k * (Math.sin(dr) * vx + Math.cos(dr) * vy);
    view.s = s;
    view.zoom = s / view.fit;
    if (gesture.rotated) showAngle(rot);
    scheduleRedraw();
  }
});

function finishTap() {
  const t = tap;
  tap = null;
  if (!t || !t.ok || t.max < 2 || performance.now() - t.t0 > 400) return false;
  if (t.max === 2) {
    if (undo()) toast('元に戻しました');
  } else if (redo()) toast('やり直しました');
  return true;
}

function onPointerEnd(e) {
  if (e.pointerId === drawPointerId) {
    touches.delete(e.pointerId);
    if (drawPointerType === 'touch' && !touches.size) tap = null;
    endDraw(); // pointercancel でも線は捨てずに確定する
    return;
  }
  if (!touches.has(e.pointerId)) return;
  const p = pt(e);
  touches.delete(e.pointerId);
  clearTimeout(lpTimer);

  if (gesture && gesture.type === 'one' && gesture.flip) {
    const dx = p.x - gesture.sx;
    const dt = performance.now() - gesture.t;
    const flick = dt < 350 && Math.abs(dx) > 50 && Math.sign(-dx) === gesture.flip.dir;
    finishFlip(e.type !== 'pointercancel' && (gesture.flip.p > 0.35 || flick));
  } else if (gesture && gesture.type === 'one' && view.zoom <= 1.01 && gesture.allowSwipe) {
    const dx = p.x - gesture.sx;
    const dy = p.y - gesture.sy;
    resetView();
    scheduleRedraw();
    if (e.type !== 'pointercancel' && gesture.flipTried && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (view.rot !== 0) turnPage(dx < 0 ? 1 : -1);
      else if (dx < 0) toast('最後のページです');
    }
  } else if (gesture && gesture.type === 'pinch') {
    const wasTap = tap && tap.ok;
    if (!wasTap) {
      if (view.zoom < 1.03) resetView();
      else clampView();
      scheduleRedraw();
    }
  }

  if (touches.size > 0) {
    startGesture({ allowSwipe: false });
  } else {
    gesture = null;
    finishTap();
    // 書いている途中なら、書き終わってから整える（ペン先の下でページが動かないように）
    if (stroke) needSettle = true;
    else settleView();
  }
}
stage.addEventListener('pointerup', onPointerEnd);
stage.addEventListener('pointercancel', onPointerEnd);

// マウス（Mac等で確認する時用）：ホイールでスクロール、ピンチ/⌘+ホイールで拡大
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (flip) return;
    stageRect = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const p = pt(e);
      const [px, py] = toPageXY(p.x, p.y);
      view.s = Math.min(view.fit * 5, Math.max(view.fit, view.s * Math.exp(-e.deltaY * 0.01)));
      view.zoom = view.s / view.fit;
      const [nx, ny] = toScreen(px, py);
      view.cx += p.x - nx;
      view.cy += p.y - ny;
    } else if (view.zoom > 1.01) {
      view.cx -= e.deltaX;
      view.cy -= e.deltaY;
    }
    clampView();
    scheduleRedraw();
  },
  { passive: false },
);

/* ================= ページ操作 ================= */
function goTo(i) {
  if (i < 0 || i >= pages.length) return;
  if (stroke) endDraw();
  finishImageEdit();
  cur = i;
  nb.lastPage = i;
  markDirty(pages[cur]);
  resetView();
  redraw();
  updateUI();
  if (pagesPanel.classList.contains('open')) renderPagesPanel();
}

async function addPage(at = pages.length) {
  const p = newPage(pages[cur] ? pages[cur].paper : 'blank');
  pages.splice(at, 0, p);
  nb.pageIds = pages.map((x) => x.id);
  await db.put('pages', p);
  await db.put('notebooks', nb);
  return at;
}

async function deletePage(i) {
  if (pages.length <= 1) {
    toast('最後の1ページは削除できません');
    return;
  }
  const ok = await confirmDialog(`${i + 1}ページ目を削除しますか？`, '削除', true);
  if (!ok) return;
  const [p] = pages.splice(i, 1);
  history.delete(p.id);
  dirtyPages.delete(p);
  nb.pageIds = pages.map((x) => x.id);
  await db.del('pages', p.id);
  await db.put('notebooks', nb);
  const next = cur > i ? cur - 1 : Math.min(cur, pages.length - 1);
  goTo(next);
  renderPagesPanel();
}

function movePage(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  if (cur === i) cur = j;
  else if (cur === j) cur = i;
  nb.pageIds = pages.map((x) => x.id);
  nb.lastPage = cur;
  markDirty(pages[cur]);
  updateUI();
  renderPagesPanel();
}

function setPaper(i, paper) {
  pages[i].paper = paper;
  markDirty(pages[i]);
  if (i === cur) composite();
  renderPagesPanel();
}

function openPageMenu(x, y) {
  if (flip) return;
  const items = [];
  if (stageRect) {
    const item = imageAt(...toPageXY(x - stageRect.left, y - stageRect.top));
    if (item) {
      items.push(
        { label: '画像を移動・拡大縮小', action: () => startImageEdit(item) },
        { label: '画像を削除', danger: true, action: () => deleteImage(item) },
        '-',
      );
    }
  }
  items.push(
    { label: '写真を貼り付け', action: pickPhoto },
    { label: 'コピーした画像を貼り付け', action: pasteFromClipboard },
    '-',
    { label: 'このページをPDFに書き出し', action: () => hooks.onExportPdf([pages[cur]], `${nb.name}_p${cur + 1}`) },
    { label: '1冊まるごとPDFに書き出し', action: exportAll },
    '-',
    { label: 'ページを追加', action: async () => goTo(await addPage(cur + 1)) },
    ...(view.rot !== 0 ? [{ label: '紙の向きをまっすぐに戻す', action: resetRotation }] : []),
    { label: 'このページを全消し', danger: true, action: clearPage },
  );
  showMenu(x, y, items);
}

async function exportAll() {
  await flush();
  hooks.onExportPdf(pages, nb.name);
}

/* ================= ページ一覧パネル ================= */
async function renderPagesPanel() {
  await preloadImages(pages);
  const list = $('#pages-list');
  list.innerHTML = '';
  const TW = 200;
  pages.forEach((p, i) => {
    const thumb = el('canvas', { class: 'pi-thumb' });
    thumb.width = TW;
    thumb.height = Math.round((TW * PAGE_H) / PAGE_W);
    const tctx = thumb.getContext('2d');
    tctx.scale(TW / PAGE_W, TW / PAGE_W);
    renderPage(tctx, p);
    thumb.addEventListener('click', () => goTo(i));

    const seg = el('div', { class: 'seg small' });
    for (const [k, label] of Object.entries(PAPERS)) {
      seg.append(el('button', { class: p.paper === k ? 'active' : '', text: label, onclick: () => setPaper(i, k) }));
    }
    const actions = el('div', { class: 'pi-actions' }, [
      el('button', { text: '↑', 'aria-label': '上へ', disabled: i === 0 ? '' : null, onclick: () => movePage(i, -1) }),
      el('button', { text: '↓', 'aria-label': '下へ', disabled: i === pages.length - 1 ? '' : null, onclick: () => movePage(i, 1) }),
      el('button', { class: 'danger', text: '削除', onclick: () => deletePage(i) }),
    ]);

    list.append(
      el('div', { class: 'page-item' + (i === cur ? ' current' : '') }, [
        thumb,
        el('div', { class: 'pi-side' }, [el('div', { class: 'pi-num', text: `${i + 1}` }), seg, actions]),
      ]),
    );
  });
  const currentEl = list.querySelector('.current');
  if (currentEl) currentEl.scrollIntoView({ block: 'nearest' });
}

function togglePagesPanel() {
  const open = !pagesPanel.classList.contains('open');
  penPanel.classList.add('hidden');
  finishImageEdit();
  pagesPanel.classList.toggle('open', open);
  $('#pages-btn').classList.toggle('active', open);
  if (open) renderPagesPanel();
}

/* ================= ペン・消しゴムの設定パネル ================= */
function section(label, content) {
  return el('div', { class: 'pp-section' }, [el('div', { class: 'pp-label', text: label }), content]);
}

function widthSlider({ min, max, value, previewFor, onInput }) {
  const fmt = (v) => (Math.round(v * 10) / 10).toString();
  const range = el('input', { type: 'range', min, max, step: '0.5', value: String(value) });
  const label = el('span', { class: 'slider-val', text: fmt(value) });
  const preview = el('div', { class: 'width-preview' });
  const drawPreview = (v) => {
    preview.innerHTML = previewFor(v * view.fit); // 拡大していない時の画面上の太さで表示
  };
  drawPreview(value);
  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    label.textContent = fmt(v);
    drawPreview(v);
    onInput(v);
  });
  range.addEventListener('change', saveSettings);
  return el('div', { class: 'slider-box' }, [preview, el('div', { class: 'slider-row' }, [range, label])]);
}

function toggleRow(label, note, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
    saveSettings();
  });
  return el('label', { class: 'switch-row' }, [el('span', { html: `${label}<small>${note}</small>` }), input]);
}

function renderPenPanel() {
  penPanel.innerHTML = '';
  if (tool === 'eraser') return renderEraserPanel();

  const pen = currentPen();
  const def = PENS[pen.type];
  penPanel.append(el('div', { class: 'pp-title', text: `ペン${settings.activePen + 1}の設定` }));

  const types = el('div', { class: 'seg' });
  for (const [k, v] of Object.entries(PENS)) {
    types.append(
      el('button', {
        class: k === pen.type ? 'active' : '',
        text: v.label,
        onclick: () => {
          if (pen.type === k) return;
          pen.type = k;
          pen.width = PENS[k].def;
          penChanged();
        },
      }),
    );
  }

  const slider = widthSlider({
    min: def.min,
    max: def.max,
    value: Math.min(def.max, Math.max(def.min, pen.width)),
    previewFor: (w) =>
      `<svg viewBox="0 0 240 44"><path d="M14 26 C 60 6, 110 40, 160 20 S 220 14, 226 22" fill="none" stroke="${pen.color}" stroke-width="${Math.max(1, w)}" stroke-linecap="round" opacity="${def.alpha < 1 ? 0.45 : 1}"/></svg>`,
    onInput: (v) => {
      pen.width = v;
    },
  });

  const colors = colorSection(pen);

  penPanel.append(
    section('ペンの種類', types),
    section('太さ', slider),
    section('色', colors),
    toggleRow('図形の自動補正', '線・円・四角・三角を書いて、最後にペンを少し止めると整います', settings.shapeSnap, (v) => (settings.shapeSnap = v)),
    fingerRow(),
  );
}

/* --- 色：基本の8色（編集可）＋ほかの色 --- */
let paletteEdit = false;
const sameColor = (a, b) => a.toLowerCase() === b.toLowerCase();

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 200;
}

// 色選択の丸。<label> の中に透明な <input type=color> を重ねると、タップでiPadの色選択が開く
function colorPicker({ value, cls, label, onInput, onChange }) {
  const input = el('input', { type: 'color', value: value.toLowerCase(), 'aria-label': label });
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('change', () => onChange(input.value));
  return el('label', { class: `swatch picker ${cls}` }, input);
}

function colorSection(pen) {
  const grid = el('div', { class: 'swatches' + (paletteEdit ? ' editing' : '') });
  settings.palette.forEach((c, i) => {
    if (paletteEdit) {
      const sw = colorPicker({
        value: c,
        cls: 'edit' + (isLight(c) ? ' light' : ''),
        label: `色${i + 1}を変更`,
        onInput: (v) => {
          settings.palette[i] = v;
          pen.color = v;
          sw.style.background = v;
          sw.classList.toggle('light', isLight(v));
          updatePenButtons();
        },
        onChange: () => saveSettings(),
      });
      sw.style.background = c;
      grid.append(sw);
    } else {
      grid.append(
        el('button', {
          class: 'swatch' + (sameColor(c, pen.color) ? ' selected' : '') + (isLight(c) ? ' light' : ''),
          style: `background:${c}`,
          'aria-label': c,
          onclick: () => {
            pen.color = c;
            penChanged();
          },
        }),
      );
    }
  });

  // ほかの色（パレットにない色を自由に）
  const custom = !settings.palette.some((c) => sameColor(c, pen.color));
  const other = colorPicker({
    value: pen.color,
    cls: 'rainbow' + (custom && !paletteEdit ? ' selected' : ''),
    label: 'ほかの色',
    onInput: (v) => {
      pen.color = v;
      other.style.setProperty('--picked', v);
      updatePenButtons();
    },
    onChange: () => {
      saveSettings();
      renderPenPanel();
    },
  });
  if (custom) other.style.setProperty('--picked', pen.color);
  if (!paletteEdit) grid.append(other);

  const actions = el('div', { class: 'color-actions' });
  if (paletteEdit) {
    actions.append(
      el('span', { class: 'color-hint', text: '丸をタップして変更' }),
      el('button', {
        text: '初期の色に戻す',
        onclick: () => {
          settings.palette = COLORS.slice();
          saveSettings();
          renderPenPanel();
        },
      }),
      el('button', { class: 'primary', text: '完了', onclick: () => { paletteEdit = false; renderPenPanel(); } }),
    );
  } else {
    actions.append(
      el('span', { class: 'color-hint', text: custom ? `ほかの色：${pen.color}` : '' }),
      el('button', { text: '色を編集', onclick: () => { paletteEdit = true; renderPenPanel(); } }),
    );
  }
  return el('div', { class: 'color-box' }, [grid, actions]);
}

function renderEraserPanel() {
  penPanel.append(el('div', { class: 'pp-title', text: '消しゴムの設定' }));
  const slider = widthSlider({
    min: ERASER.min,
    max: ERASER.max,
    value: settings.eraserWidth,
    previewFor: (w) => {
      const d = Math.min(120, Math.max(4, w));
      return `<div class="eraser-dot" style="width:${d}px;height:${d}px"></div>`;
    },
    onInput: (v) => {
      settings.eraserWidth = v;
    },
  });
  penPanel.append(
    section('太さ', slider),
    el('div', { class: 'pp-section' }, [el('button', { class: 'clear-btn', text: 'このページを全消し', onclick: clearPage })]),
    fingerRow(),
  );
}

function fingerRow() {
  const kind = { pen: 'ペン（Apple Pencil型）', touch: '指（タッチ）', mouse: 'マウス' }[lastInputType];
  return toggleRow(
    '指でも描く',
    'オフ：指はスワイプ・拡大・長押しメニュー用' + (kind ? `<br>最後に検出した入力：${kind}` : ''),
    settings.fingerDraw,
    (v) => (settings.fingerDraw = v),
  );
}

function penChanged() {
  saveSettings();
  renderPenPanel();
  updateUI();
}

function openPanel() {
  pagesPanel.classList.remove('open');
  $('#pages-btn').classList.remove('active');
  finishImageEdit();
  renderPenPanel();
  penPanel.classList.remove('hidden');
  const anchor = (tool === 'eraser' ? $('#eraser-btn') : $(`#pen${settings.activePen + 1}-btn`)).getBoundingClientRect();
  const body = penPanel.parentElement.getBoundingClientRect();
  const w = penPanel.offsetWidth;
  penPanel.style.left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2 - body.left), body.width - w - 8) + 'px';
}

function togglePanel() {
  if (penPanel.classList.contains('hidden')) openPanel();
  else penPanel.classList.add('hidden');
}

function panelsOpen() {
  return pagesPanel.classList.contains('open') || !penPanel.classList.contains('hidden');
}

function closePanels() {
  pagesPanel.classList.remove('open');
  penPanel.classList.add('hidden');
  $('#pages-btn').classList.remove('active');
}

function selectPen(i) {
  if (tool === 'pen' && settings.activePen === i) return togglePanel();
  tool = 'pen';
  settings.activePen = i;
  saveSettings();
  penPanel.classList.add('hidden');
  updateUI();
}

function selectEraser() {
  if (tool === 'eraser') return togglePanel();
  tool = 'eraser';
  penPanel.classList.add('hidden');
  updateUI();
}

/* ================= ツールバー ================= */
function updateUI() {
  if (!nb) return;
  $('#page-num').textContent = `${cur + 1}/${pages.length}`;
  $('#prev-btn').disabled = cur === 0;
  const h = history.get(pages[cur].id);
  $('#undo-btn').disabled = !h || !h.undo.length;
  $('#redo-btn').disabled = !h || !h.redo.length;
  updatePenButtons();
  $('#eraser-btn').classList.toggle('active', tool === 'eraser');
  if (!penPanel.classList.contains('hidden')) openPanel();
}

function updatePenButtons() {
  settings.pens.forEach((p, i) => {
    const btn = $(`#pen${i + 1}-btn`);
    btn.classList.toggle('active', tool === 'pen' && settings.activePen === i);
    btn.style.setProperty('--pen-color', p.color);
    btn.classList.toggle('light-pen', isLight(p.color)); // 白などの明るい色はアイコンを縁取り
    btn.title = `ペン${i + 1}（${PENS[p.type].label}）`;
  });
}

$('#back-btn').addEventListener('click', () => hooks.onExit && hooks.onExit());
$('#pages-btn').addEventListener('click', togglePagesPanel);
$('#pages-close').addEventListener('click', togglePagesPanel);
$('#add-page-btn').addEventListener('click', async () => {
  const i = await addPage();
  goTo(i);
});
$('#undo-btn').addEventListener('click', undo);
$('#redo-btn').addEventListener('click', redo);
$('#pen1-btn').addEventListener('click', () => selectPen(0));
$('#pen2-btn').addEventListener('click', () => selectPen(1));
$('#eraser-btn').addEventListener('click', selectEraser);
$('#pen-settings-btn').addEventListener('click', togglePanel);
$('#photo-btn').addEventListener('click', pickPhoto);
$('#more-btn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  stageRect = null; // ボタンからのメニューでは画像の項目を出さない
  openPageMenu(r.right - 240, r.bottom + 6);
});
$('#prev-btn').addEventListener('click', prevPage);
$('#next-btn').addEventListener('click', nextPage);

document.addEventListener('keydown', (e) => {
  if (!isOpen || !$('#dialog').classList.contains('hidden')) return;
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (e.key === 'ArrowRight') nextPage();
  else if (e.key === 'ArrowLeft') prevPage();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && editItem) deleteImage(editItem);
});
