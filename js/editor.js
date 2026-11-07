// ノート編集画面：描画・ジェスチャー・ページ操作・ペン設定
import { db, uid } from './db.js';
import { PAGE_W, PAGE_H, PENS, ERASER, COLORS, PAPERS, renderPage, drawPaper, drawInk, drawStroke } from './render.js';
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

let nb = null;
let pages = [];
let cur = 0;
let hooks = {};
let isOpen = false;

const view = { fit: 1, s: 1, zoom: 1, tx: 0, ty: 0 };
let W = 0, H = 0, dpr = 1;
let stageRect = null;

let tool = 'pen'; // 'pen' | 'eraser'
let lastInputType = null;

const history = new Map(); // pageId -> { undo: [], redo: [] }
const dirtyPages = new Set();
let saveTimer = null;

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
  nb.pageIds = pages.map((p) => p.id);
  cur = Math.min(Math.max(0, nb.lastPage || 0), pages.length - 1);
  history.clear();
  tool = 'pen';
  isOpen = true;
  $('#nb-title').textContent = nb.name;
  closePanels();
  resize();
  resetView();
  redraw();
  updateUI();
}

export async function closeEditor() {
  if (stroke) endDraw();
  closePanels();
  await flush();
  isOpen = false;
  nb = null;
  pages = [];
}

function newPage(paper) {
  return { id: uid(), notebookId: nb.id, paper, strokes: [], createdAt: Date.now() };
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
  view.fit = Math.min((W - 28) / PAGE_W, (H - 28) / PAGE_H);
}

function resetView() {
  view.zoom = 1;
  view.s = view.fit;
  view.tx = (W - PAGE_W * view.s) / 2;
  view.ty = (H - PAGE_H * view.s) / 2;
}

function clampView() {
  const pw = PAGE_W * view.s;
  const ph = PAGE_H * view.s;
  const m = 60;
  view.tx = pw <= W ? (W - pw) / 2 : Math.min(m, Math.max(W - pw - m, view.tx));
  view.ty = ph <= H ? (H - ph) / 2 : Math.min(m, Math.max(H - ph - m, view.ty));
}

function applyT(ctx) {
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
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

// 背景＋用紙＋インク層を画面に合成
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
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.drawImage(ink, 0, 0);
  bctx.restore();
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
    // 消しゴムの範囲を丸で表示
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

window.addEventListener('resize', () => {
  if (!isOpen) return;
  resize();
  resetView();
  redraw();
});

/* ================= 描画 ================= */
let stroke = null; // 描いている途中の線（ペン or 消しゴム）
let drawPointerId = null;
let drawPointerType = null;

function toPage(e) {
  return [(e.clientX - stageRect.left - view.tx) / view.s, (e.clientY - stageRect.top - view.ty) / view.s];
}

function pressureOf(e) {
  if (e.pointerType !== 'pen') return 0.5;
  return e.pressure > 0 ? e.pressure : 0.5;
}

const r2 = (v) => Math.round(v * 100) / 100;

// 消しゴムの一区間をインク層から削る
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
  scheduleLive();
}

function moveDraw(e) {
  if (!stroke) return;
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const ev of evs.length ? evs : [e]) {
    const [x, y] = toPage(ev);
    const last = stroke.points[stroke.points.length - 1];
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
  drawPointerId = null;
  drawPointerType = null;
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  pages[cur].strokes.push(s);
  pushHistory({ type: 'add', stroke: s });
  if (s.tool !== 'eraser') {
    applyT(ictx);
    drawStroke(ictx, s);
  }
  composite();
  renderLive();
  markDirty();
}

// 描きかけを取り消す（2本指ピンチに切り替わった時など）
function abortDraw() {
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

function revert(op) {
  const page = pages[cur];
  if (op.type === 'add') {
    const i = page.strokes.lastIndexOf(op.stroke);
    if (i >= 0) page.strokes.splice(i, 1);
  } else if (op.type === 'clear') {
    page.strokes = op.prev;
  }
}

function reapply(op) {
  const page = pages[cur];
  if (op.type === 'add') page.strokes.push(op.stroke);
  else if (op.type === 'clear') page.strokes = [];
}

function undo() {
  if (stroke) return;
  const h = hist();
  const op = h.undo.pop();
  if (!op) return;
  revert(op);
  h.redo.push(op);
  redraw();
  markDirty();
  updateUI();
}

function redo() {
  if (stroke) return;
  const h = hist();
  const op = h.redo.pop();
  if (!op) return;
  reapply(op);
  h.undo.push(op);
  redraw();
  markDirty();
  updateUI();
}

async function clearPage() {
  if (!pages[cur].strokes.length) return toast('このページには何も書かれていません');
  closePanels();
  const ok = await confirmDialog('このページに書いた内容をすべて消しますか？\n（元に戻すボタンで戻せます）', '全消し', true);
  if (!ok) return;
  const page = pages[cur];
  pushHistory({ type: 'clear', prev: page.strokes });
  page.strokes = [];
  redraw();
  markDirty();
}

/* ================= ポインター（ペン・指・マウス） ================= */
const touches = new Map();
let gesture = null;
let lpTimer = null;

const pt = (e) => ({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

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
  if (touches.size) gesture = { type: 'none' };
}

function startGesture({ allowSwipe = true } = {}) {
  clearTimeout(lpTimer);
  const pts = [...touches.values()];
  if (pts.length === 1) {
    const p = pts[0];
    gesture = {
      type: 'one', sx: p.x, sy: p.y, t: performance.now(),
      tx0: view.tx, ty0: view.ty, moved: false, allowSwipe,
    };
    if (allowSwipe) {
      lpTimer = setTimeout(() => {
        if (gesture && gesture.type === 'one' && !gesture.moved) {
          gesture = { type: 'none' };
          openPageMenu(stageRect.left + p.x, stageRect.top + p.y);
        }
      }, 550);
    }
  } else if (pts.length >= 2) {
    const [a, b] = pts;
    gesture = { type: 'pinch', d0: dist(a, b) || 1, m0: mid(a, b), s0: view.s, tx0: view.tx, ty0: view.ty };
  }
}

// iOS の標準ジェスチャー（ダブルタップ判定・拡大鏡など）を止める。
// これが動くと、速い連続タップの線がキャンセルされることがある。
for (const type of ['touchstart', 'touchmove', 'touchend']) {
  stage.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

stage.addEventListener('pointerdown', (e) => {
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
      clearTimeout(lpTimer);
    }
  }
  if (e.pointerType === 'pen') cancelTouchGesture();

  if (drawPointerId === null && canDraw(e) && !(e.pointerType === 'touch' && touches.size > 0)) {
    capture(e);
    drawPointerId = e.pointerId;
    drawPointerType = e.pointerType;
    if (e.pointerType === 'touch') touches.set(e.pointerId, pt(e));
    beginDraw(e);
    return;
  }

  if (e.pointerType === 'touch') {
    if (drawPointerId !== null && drawPointerType === 'pen') return; // 手のひらは無視
    if (drawPointerId !== null && drawPointerType === 'touch') abortDraw(); // 2本目の指 → ピンチへ
    touches.set(e.pointerId, pt(e));
    capture(e);
    startGesture();
  }
});

stage.addEventListener('pointermove', (e) => {
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
      view.tx = gesture.tx0 + dx;
      view.ty = gesture.ty0 + dy;
      clampView();
      scheduleRedraw();
    } else if (gesture.allowSwipe) {
      view.tx = gesture.tx0 + dx * 0.5; // スワイプ中は少しページが動く
      scheduleRedraw();
    }
  } else if (gesture.type === 'pinch' && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const m = mid(a, b);
    const s = Math.min(view.fit * 5, Math.max(view.fit * 0.8, (gesture.s0 * dist(a, b)) / gesture.d0));
    const px = (gesture.m0.x - gesture.tx0) / gesture.s0;
    const py = (gesture.m0.y - gesture.ty0) / gesture.s0;
    view.s = s;
    view.zoom = s / view.fit;
    view.tx = m.x - px * s;
    view.ty = m.y - py * s;
    scheduleRedraw();
  }
});

function onPointerEnd(e) {
  if (e.pointerId === drawPointerId) {
    touches.delete(e.pointerId);
    if (e.type === 'pointerup' || e.type === 'pointercancel') {
      // pointercancel でも線は捨てずに確定する（iPadで速く書いた時に起きる）
      endDraw();
    }
    return;
  }
  if (!touches.has(e.pointerId)) return;
  const p = pt(e);
  touches.delete(e.pointerId);
  clearTimeout(lpTimer);

  if (gesture && gesture.type === 'one' && view.zoom <= 1.01 && gesture.allowSwipe) {
    const dx = p.x - gesture.sx;
    const dy = p.y - gesture.sy;
    const dt = performance.now() - gesture.t;
    if (e.type !== 'pointercancel' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 900) {
      if (dx < 0) nextPage();
      else prevPage();
    } else {
      resetView();
      scheduleRedraw();
    }
  } else if (gesture && gesture.type === 'pinch') {
    if (view.zoom < 1.03) resetView();
    else clampView();
    scheduleRedraw();
  }

  if (touches.size > 0) {
    startGesture({ allowSwipe: false });
  } else {
    gesture = null;
  }
}
stage.addEventListener('pointerup', onPointerEnd);
stage.addEventListener('pointercancel', onPointerEnd);

// マウス（Mac等で確認する時用）：ホイールでスクロール、ピンチ/⌘+ホイールで拡大
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    stageRect = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const p = pt(e);
      const s = Math.min(view.fit * 5, Math.max(view.fit, view.s * Math.exp(-e.deltaY * 0.01)));
      const px = (p.x - view.tx) / view.s;
      const py = (p.y - view.ty) / view.s;
      view.s = s;
      view.zoom = s / view.fit;
      view.tx = p.x - px * s;
      view.ty = p.y - py * s;
    } else if (view.zoom > 1.01) {
      view.tx -= e.deltaX;
      view.ty -= e.deltaY;
    }
    clampView();
    scheduleRedraw();
  },
  { passive: false },
);

/* ================= ページ操作 ================= */
function turnAnim(dir) {
  stage.classList.remove('turn-next', 'turn-prev');
  void stage.offsetWidth;
  stage.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
}

function goTo(i, anim = 0) {
  if (i < 0 || i >= pages.length) return;
  if (stroke) endDraw();
  cur = i;
  nb.lastPage = i;
  markDirty(pages[cur]);
  resetView();
  redraw();
  updateUI();
  if (anim) turnAnim(anim);
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

async function nextPage() {
  if (cur < pages.length - 1) return goTo(cur + 1, 1);
  if (pages[cur].strokes.length) {
    const i = await addPage();
    goTo(i, 1);
    toast('新しいページを追加しました');
  } else {
    resetView();
    scheduleRedraw();
    toast('最後のページです');
  }
}

function prevPage() {
  if (cur > 0) return goTo(cur - 1, -1);
  resetView();
  scheduleRedraw();
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
  showMenu(x, y, [
    { label: 'このページをPDFに書き出し', action: () => hooks.onExportPdf([pages[cur]], `${nb.name}_p${cur + 1}`) },
    { label: '1冊まるごとPDFに書き出し', action: exportAll },
    '-',
    { label: 'ページを追加', action: async () => goTo(await addPage(cur + 1), 1) },
    { label: 'このページを全消し', danger: true, action: clearPage },
  ]);
}

async function exportAll() {
  await flush();
  hooks.onExportPdf(pages, nb.name);
}

/* ================= ページ一覧パネル ================= */
function renderPagesPanel() {
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
  pagesPanel.classList.toggle('open', open);
  $('#pages-btn').classList.toggle('active', open);
  if (open) renderPagesPanel();
}

/* ================= ペン・消しゴムの設定パネル ================= */
function section(label, content) {
  return el('div', { class: 'pp-section' }, [el('div', { class: 'pp-label', text: label }), content]);
}

// 太さのスライダー（プレビュー付き）
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
          pen.width = PENS[k].def; // 種類を変えたらその種類の標準の太さに
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

  const colors = el('div', { class: 'swatches' });
  for (const c of COLORS) {
    colors.append(
      el('button', {
        class: 'swatch' + (c === pen.color ? ' selected' : ''),
        style: `background:${c}`,
        'aria-label': c,
        onclick: () => {
          pen.color = c;
          penChanged();
        },
      }),
    );
  }

  penPanel.append(section('ペンの種類', types), section('太さ', slider), section('色', colors), fingerRow());
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
    el('div', { class: 'pp-section' }, [
      el('button', { class: 'clear-btn', text: 'このページを全消し', onclick: clearPage }),
    ]),
    fingerRow(),
  );
}

function fingerRow() {
  const finger = el('input', { type: 'checkbox' });
  finger.checked = settings.fingerDraw;
  finger.addEventListener('change', () => {
    settings.fingerDraw = finger.checked;
    saveSettings();
  });
  const kind = { pen: 'ペン（Apple Pencil型）', touch: '指（タッチ）', mouse: 'マウス' }[lastInputType];
  return el('label', { class: 'switch-row' }, [
    el('span', {
      html:
        '指でも描く<small>オフ：指はスワイプ・拡大・長押しメニュー用' +
        (kind ? `<br>最後に検出した入力：${kind}` : '') +
        '</small>',
    }),
    finger,
  ]);
}

function penChanged() {
  saveSettings();
  renderPenPanel();
  updateUI();
}

function openPanel() {
  pagesPanel.classList.remove('open');
  $('#pages-btn').classList.remove('active');
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

// ペン1・ペン2：選択中のボタンをもう一度押すと設定が開く
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
  settings.pens.forEach((p, i) => {
    const btn = $(`#pen${i + 1}-btn`);
    btn.classList.toggle('active', tool === 'pen' && settings.activePen === i);
    btn.style.setProperty('--pen-color', p.color);
    btn.title = `ペン${i + 1}（${PENS[p.type].label}）`;
  });
  $('#eraser-btn').classList.toggle('active', tool === 'eraser');
  if (!penPanel.classList.contains('hidden')) openPanel();
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
$('#more-btn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
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
});
