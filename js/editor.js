// ノート編集画面：描画・ジェスチャー・ページ操作・ペン設定
import { db, uid } from './db.js';
import { PAGE_W, PAGE_H, PENS, COLORS, PAPERS, renderPage, drawStroke, hitStroke } from './render.js';
import { $, el, showMenu, toast, confirmDialog } from './ui.js';
import { settings, saveSettings, currentPen } from './settings.js';

const stage = $('#stage');
const base = $('#base-canvas');
const live = $('#live-canvas');
const bctx = base.getContext('2d');
const lctx = live.getContext('2d');
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
const ERASER_R = 12;

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
  renderFavorites();
  updateUI();
}

export async function closeEditor() {
  if (stroke || erasing) endDraw();
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
  for (const c of [base, live]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
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

function redraw() {
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
  renderPage(bctx, pages[cur]);
  bctx.restore();
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
  if (!stroke && !erasing) return;
  applyT(lctx);
  if (stroke) {
    lctx.save();
    clipPage(lctx);
    drawStroke(lctx, stroke);
    lctx.restore();
  }
  if (erasing && eraserPos) {
    lctx.beginPath();
    lctx.arc(eraserPos[0], eraserPos[1], ERASER_R, 0, Math.PI * 2);
    lctx.lineWidth = 1.5 / view.s;
    lctx.strokeStyle = 'rgba(80,80,80,0.8)';
    lctx.fillStyle = 'rgba(255,255,255,0.5)';
    lctx.fill();
    lctx.stroke();
  }
}

window.addEventListener('resize', () => {
  if (!isOpen) return;
  resize();
  resetView();
  redraw();
});

/* ================= 描画 ================= */
let stroke = null;
let erasing = null;
let eraserPos = null;
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

function beginDraw(e) {
  const [x, y] = toPage(e);
  if (tool === 'eraser') {
    erasing = { type: 'erase', items: [] };
    eraserPos = [x, y];
    eraseAt(x, y);
    scheduleLive();
    return;
  }
  const pen = currentPen();
  stroke = {
    tool: pen.type,
    color: pen.color,
    width: PENS[pen.type].widths[pen.widthIdx],
    points: [[r2(x), r2(y), r2(pressureOf(e))]],
  };
  scheduleLive();
}

function moveDraw(e) {
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
  for (const ev of evs.length ? evs : [e]) {
    const [x, y] = toPage(ev);
    if (erasing) {
      const [lx, ly] = eraserPos;
      const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 5));
      for (let i = 1; i <= steps; i++) eraseAt(lx + ((x - lx) * i) / steps, ly + ((y - ly) * i) / steps);
      eraserPos = [x, y];
      continue;
    }
    if (!stroke) continue;
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 0.5) continue;
    const p = last[2] * 0.6 + pressureOf(ev) * 0.4;
    stroke.points.push([r2(x), r2(y), r2(p)]);
  }
  scheduleLive();
}

function endDraw() {
  drawPointerId = null;
  drawPointerType = null;
  if (erasing) {
    if (erasing.items.length) {
      pushHistory(erasing);
      markDirty();
    }
    erasing = null;
    eraserPos = null;
    renderLive();
    return;
  }
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  pages[cur].strokes.push(s);
  pushHistory({ type: 'add', stroke: s });
  applyT(bctx);
  bctx.save();
  clipPage(bctx);
  drawStroke(bctx, s);
  bctx.restore();
  renderLive();
  markDirty();
}

function abortDraw() {
  stroke = null;
  endDraw();
}

function eraseAt(x, y) {
  const list = pages[cur].strokes;
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitStroke(list[i], x, y, ERASER_R)) {
      erasing.items.push({ stroke: list[i], index: i });
      list.splice(i, 1);
      changed = true;
    }
  }
  if (changed) scheduleRedraw();
}

/* ================= 元に戻す・やり直す ================= */
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
  const s = pages[cur].strokes;
  if (op.type === 'add') {
    const i = s.lastIndexOf(op.stroke);
    if (i >= 0) s.splice(i, 1);
  } else {
    for (let k = op.items.length - 1; k >= 0; k--) {
      const it = op.items[k];
      s.splice(Math.min(it.index, s.length), 0, it.stroke);
    }
  }
}

function reapply(op) {
  const s = pages[cur].strokes;
  if (op.type === 'add') s.push(op.stroke);
  else {
    for (const it of op.items) {
      const i = s.indexOf(it.stroke);
      if (i >= 0) s.splice(i, 1);
    }
  }
}

function undo() {
  if (stroke || erasing) return;
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
  if (stroke || erasing) return;
  const h = hist();
  const op = h.redo.pop();
  if (!op) return;
  reapply(op);
  h.undo.push(op);
  redraw();
  markDirty();
  updateUI();
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

stage.addEventListener('pointerdown', (e) => {
  if (panelsOpen()) {
    closePanels();
    return;
  }
  stageRect = stage.getBoundingClientRect();
  if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    if (e.type === 'pointercancel') abortDraw();
    else endDraw();
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
  if (stroke || erasing) endDraw();
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
  if (i === cur) redraw();
  renderPagesPanel();
}

function openPageMenu(x, y) {
  showMenu(x, y, [
    { label: 'このページをPDFに書き出し', action: () => hooks.onExportPdf([pages[cur]], `${nb.name}_p${cur + 1}`) },
    { label: '1冊まるごとPDFに書き出し', action: exportAll },
    '-',
    { label: 'ページを追加', action: async () => goTo(await addPage(cur + 1), 1) },
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

/* ================= ペン設定パネル ================= */
function samePen(a, b) {
  return a.type === b.type && a.color === b.color && a.widthIdx === b.widthIdx;
}

function penChanged() {
  tool = 'pen';
  saveSettings();
  renderPenPanel();
  renderFavorites();
  updateUI();
}

function renderPenPanel() {
  const P = settings.pen;
  const cfg = P[P.type];
  const pen = PENS[P.type];
  penPanel.innerHTML = '';

  const types = el('div', { class: 'seg' });
  for (const [k, v] of Object.entries(PENS)) {
    types.append(el('button', { class: k === P.type ? 'active' : '', text: v.label, onclick: () => { P.type = k; penChanged(); } }));
  }

  const widths = el('div', { class: 'width-row' });
  pen.widths.forEach((w, idx) => {
    const sw = Math.min(22, Math.max(2, w * 0.7));
    widths.append(
      el('button', {
        class: 'width-btn' + (idx === cfg.widthIdx ? ' active' : ''),
        'aria-label': `太さ${idx + 1}`,
        html: `<svg viewBox="0 0 80 30"><path d="M8 18 C 24 6, 44 26, 72 12" fill="none" stroke="${cfg.color}" stroke-width="${sw}" stroke-linecap="round" opacity="${pen.alpha < 1 ? 0.5 : 1}"/></svg>`,
        onclick: () => { cfg.widthIdx = idx; penChanged(); },
      }),
    );
  });

  const colors = el('div', { class: 'swatches' });
  for (const c of COLORS) {
    colors.append(
      el('button', {
        class: 'swatch' + (c === cfg.color ? ' selected' : ''),
        style: `background:${c}`,
        'aria-label': c,
        onclick: () => { cfg.color = c; penChanged(); },
      }),
    );
  }

  const favs = el('div', { class: 'fav-edit' });
  settings.favorites.forEach((f, i) => {
    favs.append(
      el('div', { class: 'fav-chip' }, [
        favDot(f),
        el('span', { text: PENS[f.type].label }),
        el('button', {
          class: 'fav-del',
          text: '×',
          'aria-label': '登録を解除',
          onclick: () => { settings.favorites.splice(i, 1); penChanged(); },
        }),
      ]),
    );
  });
  const curPen = currentPen();
  const already = settings.favorites.some((f) => samePen(f, curPen));
  favs.append(
    el('button', {
      class: 'fav-add',
      text: already ? '登録済み' : '＋ 今のペンを登録',
      disabled: already ? '' : null,
      onclick: () => {
        if (settings.favorites.length >= 6) return toast('登録は6本までです');
        settings.favorites.push({ type: curPen.type, color: curPen.color, widthIdx: curPen.widthIdx });
        penChanged();
      },
    }),
  );

  const finger = el('input', { type: 'checkbox' });
  finger.checked = settings.fingerDraw;
  finger.addEventListener('change', () => {
    settings.fingerDraw = finger.checked;
    saveSettings();
  });

  penPanel.append(
    section('ペンの種類', types),
    section('太さ', widths),
    section('色', colors),
    section('よく使うペン', favs),
    el('label', { class: 'switch-row' }, [
      el('span', { html: '指でも描く<small>オフ：指はスワイプ・拡大・長押しメニュー用</small>' }),
      finger,
    ]),
  );
}

function section(label, content) {
  return el('div', { class: 'pp-section' }, [el('div', { class: 'pp-label', text: label }), content]);
}

function favDot(f) {
  const size = [10, 14, 18][f.widthIdx] || 14;
  return el('span', {
    class: 'fav-dot ' + f.type,
    style: `background:${f.color};width:${size}px;height:${size}px`,
  });
}

function renderFavorites() {
  const box = $('#favorites');
  box.innerHTML = '';
  const curPen = currentPen();
  for (const f of settings.favorites) {
    box.append(
      el('button', {
        class: 'fav' + (tool === 'pen' && samePen(f, curPen) ? ' active' : ''),
        'aria-label': PENS[f.type].label,
        onclick: () => {
          settings.pen.type = f.type;
          settings.pen[f.type] = { color: f.color, widthIdx: f.widthIdx };
          penChanged();
        },
      }, favDot(f)),
    );
  }
}

function togglePenPanel() {
  const show = penPanel.classList.contains('hidden');
  pagesPanel.classList.remove('open');
  $('#pages-btn').classList.remove('active');
  if (!show) return penPanel.classList.add('hidden');
  renderPenPanel();
  penPanel.classList.remove('hidden');
  const btn = $('#pen-settings-btn').getBoundingClientRect();
  const body = penPanel.parentElement.getBoundingClientRect();
  const w = penPanel.offsetWidth;
  penPanel.style.left = Math.min(Math.max(8, btn.left + btn.width / 2 - w / 2 - body.left), body.width - w - 8) + 'px';
}

function panelsOpen() {
  return pagesPanel.classList.contains('open') || !penPanel.classList.contains('hidden');
}

function closePanels() {
  pagesPanel.classList.remove('open');
  penPanel.classList.add('hidden');
  $('#pages-btn').classList.remove('active');
}

/* ================= ツールバー ================= */
function updateUI() {
  if (!nb) return;
  $('#page-num').textContent = `${cur + 1}/${pages.length}`;
  $('#prev-btn').disabled = cur === 0;
  const h = history.get(pages[cur].id);
  $('#undo-btn').disabled = !h || !h.undo.length;
  $('#redo-btn').disabled = !h || !h.redo.length;
  $('#pen-btn').classList.toggle('active', tool === 'pen');
  $('#eraser-btn').classList.toggle('active', tool === 'eraser');
  const p = currentPen();
  $('.pen-dot').style.background = p.color;
  const curPen = currentPen();
  [...$('#favorites').children].forEach((b, i) => {
    b.classList.toggle('active', tool === 'pen' && samePen(settings.favorites[i], curPen));
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
$('#pen-btn').addEventListener('click', () => {
  if (tool === 'pen') return togglePenPanel();
  tool = 'pen';
  updateUI();
  renderFavorites();
});
$('#eraser-btn').addEventListener('click', () => {
  tool = 'eraser';
  penPanel.classList.add('hidden');
  updateUI();
  renderFavorites();
});
$('#pen-settings-btn').addEventListener('click', togglePenPanel);
$('#more-btn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openPageMenu(r.right - 240, r.bottom + 6);
});
$('#prev-btn').addEventListener('click', prevPage);
$('#next-btn').addEventListener('click', nextPage);

document.addEventListener('keydown', (e) => {
  if (!isOpen || !$('#dialog').classList.contains('hidden')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (e.key === 'ArrowRight') nextPage();
  else if (e.key === 'ArrowLeft') prevPage();
});
