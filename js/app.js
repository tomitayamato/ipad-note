// エントリーポイント：本棚（段分け・並べ替え）、画面切り替え、バックアップ
import { db, uid } from './db.js';
import { loadSettings } from './settings.js';
import { PAPERS } from './render.js';
import { $, el, showMenu, hideMenu, openDialog, confirmDialog, toast, saveFile } from './ui.js';
import { openEditor, closeEditor } from './editor.js';
import { exportPdfFlow } from './pdf.js';

export const COVER_COLORS = ['#b23a48', '#2d6a8f', '#3c7a4a', '#c47f2c', '#6a4c93', '#2f3e46', '#b5838d', '#8d6e63'];

const shelfView = $('#shelf-view');
const editorView = $('#editor-view');
const shelfEl = $('#shelf');

/* ---------- 段（棚） ---------- */
let shelves = []; // [{ id, name }]（上から順）

async function loadShelves() {
  const rec = await db.get('meta', 'shelves');
  shelves = rec && Array.isArray(rec.value) && rec.value.length ? rec.value : [{ id: 'main', name: 'ノート' }];
}

function saveShelves() {
  return db.put('meta', { key: 'shelves', value: shelves });
}

const orderOf = (nb) => (typeof nb.order === 'number' ? nb.order : nb.createdAt);
const shelfOf = (nb) => (shelves.some((s) => s.id === nb.shelfId) ? nb.shelfId : shelves[0].id);

async function nextOrder(shelfId) {
  const nbs = (await db.getAll('notebooks')).filter((n) => shelfOf(n) === shelfId);
  return nbs.length ? Math.max(...nbs.map(orderOf)) + 1 : 0;
}

async function createNotebook(name, color, paper, shelfId = shelves[0].id) {
  const now = Date.now();
  const nb = {
    id: uid(), name, color, pageIds: [], createdAt: now, updatedAt: now, lastPage: 0,
    shelfId, order: await nextOrder(shelfId),
  };
  const page = { id: uid(), notebookId: nb.id, paper, strokes: [], images: [], createdAt: now };
  nb.pageIds = [page.id];
  await db.put('pages', page);
  await db.put('notebooks', nb);
  return nb;
}

/* ---------- 本棚の表示 ---------- */
async function renderShelf() {
  const nbs = await db.getAll('notebooks');
  shelfEl.innerHTML = '';
  for (const sh of shelves) {
    const list = nbs.filter((n) => shelfOf(n) === sh.id).sort((a, b) => orderOf(a) - orderOf(b));
    const grid = el('div', { class: 'shelf-grid', 'data-shelf': sh.id });
    for (const nb of list) grid.append(bookEl(nb));
    if (!list.length) {
      grid.append(
        el('div', {
          class: 'shelf-empty-slot',
          text: nbs.length ? 'ノートを長押しして、ここへドラッグ' : '右上の ＋ から新しいノートを作成しましょう',
        }),
      );
    }
    const label = el('div', { class: 'shelf-label' }, [
      el('span', { class: 'plaque', text: sh.name }),
      el('button', {
        class: 'plaque-btn',
        'aria-label': '段のメニュー',
        html: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          sectionMenu(sh, r.left, r.bottom + 6);
        },
      }),
    ]);
    shelfEl.append(el('section', { class: 'shelf-section', 'data-shelf': sh.id }, [label, grid]));
  }
}

function bookEl(nb) {
  const book = el('div', { class: 'book', style: `--cover:${nb.color}`, 'data-id': nb.id }, [
    el('div', { class: 'book-label' }, el('span', { class: 'book-title', text: nb.name })),
    el('div', { class: 'book-meta', text: `${nb.pageIds.length} ページ` }),
  ]);
  attachBook(book, nb);
  return book;
}

/* ---------- タップ・長押し・ドラッグ ---------- */
// タップ：開く ／ 長押し：持ち上がる →（そのまま離す：メニュー ／ 動かす：並べ替え）
let drag = null;

function attachBook(book, nb) {
  let st = null;
  const reset = () => {
    if (st) clearTimeout(st.timer);
    st = null;
    book.classList.remove('pressed', 'lifted');
  };

  book.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || drag) return;
    try {
      book.setPointerCapture(e.pointerId);
    } catch (_) {}
    st = { x: e.clientX, y: e.clientY, lifted: false, dragging: false };
    book.classList.add('pressed');
    st.timer = setTimeout(() => {
      if (!st) return;
      st.lifted = true;
      book.classList.remove('pressed');
      book.classList.add('lifted');
    }, 450);
  });

  book.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (st.dragging) return moveDrag(e.clientX, e.clientY);
    const d = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.lifted) {
      if (d > 10) reset(); // スクロールしようとしている
    } else if (d > 8) {
      st.dragging = true;
      beginDrag(book, e.clientX, e.clientY);
    }
  });

  book.addEventListener('pointerup', (e) => {
    if (!st) return;
    const s = st;
    reset();
    if (s.dragging) endDrag();
    else if (s.lifted) bookMenu(nb, e.clientX, e.clientY);
    else openNotebook(nb.id);
  });

  book.addEventListener('pointercancel', () => {
    const wasDragging = st && st.dragging;
    reset();
    if (wasDragging) endDrag();
  });

  // 持ち上げた後は画面がスクロールしないようにする
  book.addEventListener('touchmove', (e) => {
    if (st && st.lifted) e.preventDefault();
  }, { passive: false });

  book.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    reset();
    bookMenu(nb, e.clientX, e.clientY);
  });
}

function beginDrag(book, x, y) {
  const r = book.getBoundingClientRect();
  const ghost = book.cloneNode(true);
  ghost.classList.remove('pressed', 'lifted');
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px' });
  document.body.append(ghost);
  book.classList.add('drag-origin');
  drag = { book, ghost, offX: x - r.left, offY: y - r.top };
  moveDrag(x, y);
}

function moveDrag(x, y) {
  if (!drag) return;
  const { book, ghost } = drag;
  ghost.style.left = x - drag.offX + 'px';
  ghost.style.top = y - drag.offY + 'px';

  // 画面の端に近づいたら自動でスクロール
  const sr = shelfEl.getBoundingClientRect();
  if (y < sr.top + 70) shelfEl.scrollTop -= 14;
  else if (y > sr.bottom - 70) shelfEl.scrollTop += 14;

  const under = document.elementFromPoint(x, y);
  if (!under) return;
  const target = under.closest('.book');
  if (target && target !== book && !target.classList.contains('drag-ghost')) {
    const tr = target.getBoundingClientRect();
    const before = x < tr.left + tr.width / 2;
    const ref = before ? target : target.nextSibling;
    if (ref !== book && book.nextSibling !== ref) target.parentElement.insertBefore(book, ref);
    else if (ref !== book && book.parentElement !== target.parentElement) target.parentElement.insertBefore(book, ref);
    cleanEmptySlots();
    return;
  }
  const section = under.closest('.shelf-section');
  if (section && !target) {
    const grid = $('.shelf-grid', section);
    if (book.parentElement !== grid) {
      grid.append(book);
      cleanEmptySlots();
    }
  }
}

function cleanEmptySlots() {
  for (const grid of shelfEl.querySelectorAll('.shelf-grid')) {
    const slot = $('.shelf-empty-slot', grid);
    if (slot && grid.querySelector('.book')) slot.remove();
  }
}

async function endDrag() {
  if (!drag) return;
  const { book, ghost } = drag;
  drag = null;
  ghost.remove();
  book.classList.remove('drag-origin');
  const nbs = new Map((await db.getAll('notebooks')).map((n) => [n.id, n]));
  for (const grid of shelfEl.querySelectorAll('.shelf-grid')) {
    const shelfId = grid.dataset.shelf;
    const books = [...grid.querySelectorAll('.book')];
    for (let i = 0; i < books.length; i++) {
      const nb = nbs.get(books[i].dataset.id);
      if (nb && (nb.shelfId !== shelfId || nb.order !== i)) {
        nb.shelfId = shelfId;
        nb.order = i;
        await db.put('notebooks', nb);
      }
    }
  }
  await renderShelf();
}

/* ---------- メニュー ---------- */
function bookMenu(nb, x, y) {
  const items = [{ label: '名前・表紙を編集', action: () => editNotebook(nb) }];
  if (shelves.length > 1) items.push({ label: '別の段へ移動', action: () => moveToShelfMenu(nb, x, y) });
  items.push(
    { label: '1冊まるごとPDFに書き出し', action: () => exportNotebook(nb) },
    '-',
    { label: '削除', danger: true, action: () => deleteNotebook(nb) },
  );
  showMenu(x, y, items);
}

function moveToShelfMenu(nb, x, y) {
  const current = shelfOf(nb);
  showMenu(
    x,
    y,
    shelves.filter((s) => s.id !== current).map((s) => ({
      label: `「${s.name}」へ`,
      action: async () => {
        const fresh = await db.get('notebooks', nb.id);
        fresh.shelfId = s.id;
        fresh.order = await nextOrder(s.id);
        await db.put('notebooks', fresh);
        await renderShelf();
      },
    })),
  );
}

function sectionMenu(sh, x, y) {
  const i = shelves.indexOf(sh);
  const items = [{ label: '段の名前を変更', action: () => renameShelf(sh) }];
  if (i > 0) items.push({ label: '上へ移動', action: () => moveShelf(i, -1) });
  if (i < shelves.length - 1) items.push({ label: '下へ移動', action: () => moveShelf(i, 1) });
  items.push('-', { label: '段を追加', action: addShelf });
  if (shelves.length > 1) items.push({ label: 'この段を削除', danger: true, action: () => deleteShelf(sh) });
  showMenu(x, y, items);
}

async function askName(title, value, okLabel) {
  const input = el('input', { type: 'text', maxlength: '20', value });
  const ok = await openDialog({
    title,
    body: el('div', { class: 'form' }, el('label', { class: 'field' }, [el('span', { text: '名前' }), input])),
    buttons: [
      { label: 'キャンセル', value: false },
      { label: okLabel, value: true, primary: true, validate: () => input.value.trim() !== '' },
    ],
  });
  return ok ? input.value.trim() : null;
}

async function addShelf() {
  const name = await askName('段を追加', '新しい段', '追加');
  if (!name) return;
  shelves.push({ id: uid(), name });
  await saveShelves();
  await renderShelf();
  shelfEl.scrollTop = shelfEl.scrollHeight;
}

async function renameShelf(sh) {
  const name = await askName('段の名前を変更', sh.name, '保存');
  if (!name) return;
  sh.name = name;
  await saveShelves();
  await renderShelf();
}

async function moveShelf(i, dir) {
  const j = i + dir;
  [shelves[i], shelves[j]] = [shelves[j], shelves[i]];
  await saveShelves();
  await renderShelf();
}

async function deleteShelf(sh) {
  const nbs = (await db.getAll('notebooks')).filter((n) => shelfOf(n) === sh.id);
  const rest = shelves.filter((s) => s !== sh);
  const msg = nbs.length
    ? `段「${sh.name}」を削除しますか？\nこの段のノート ${nbs.length} 冊は「${rest[0].name}」へ移動します（ノートは消えません）。`
    : `段「${sh.name}」を削除しますか？`;
  if (!(await confirmDialog(msg, '削除', true))) return;
  let order = await nextOrder(rest[0].id);
  for (const nb of nbs.sort((a, b) => orderOf(a) - orderOf(b))) {
    nb.shelfId = rest[0].id;
    nb.order = order++;
    await db.put('notebooks', nb);
  }
  shelves = rest;
  await saveShelves();
  await renderShelf();
}

/* ---------- ノートの作成・編集・削除 ---------- */
function notebookForm({ name, color, paper, isNew, shelfId }) {
  const state = { name, color, paper, shelfId };
  const input = el('input', { type: 'text', maxlength: '40', value: name });
  input.addEventListener('input', () => (state.name = input.value));

  const swatches = el('div', { class: 'swatches' });
  const drawSwatches = () => {
    swatches.innerHTML = '';
    for (const c of COVER_COLORS) {
      swatches.append(
        el('button', {
          class: 'swatch cover' + (c === state.color ? ' selected' : ''),
          style: `background:${c}`,
          'aria-label': c,
          onclick: () => {
            state.color = c;
            drawSwatches();
          },
        }),
      );
    }
  };
  drawSwatches();

  const body = el('div', { class: 'form' }, [
    el('label', { class: 'field' }, [el('span', { text: '名前' }), input]),
    el('div', { class: 'field' }, [el('span', { text: '表紙の色' }), swatches]),
  ]);

  const segField = (label, options, key) => {
    const seg = el('div', { class: 'seg wrap' });
    const draw = () => {
      seg.innerHTML = '';
      for (const [k, text] of options) {
        seg.append(el('button', { class: k === state[key] ? 'active' : '', text, onclick: () => { state[key] = k; draw(); } }));
      }
    };
    draw();
    body.append(el('div', { class: 'field' }, [el('span', { text: label }), seg]));
  };

  if (isNew) {
    segField('用紙', Object.entries(PAPERS), 'paper');
    if (shelves.length > 1) segField('置く段', shelves.map((s) => [s.id, s.name]), 'shelfId');
  }
  return { body, state };
}

async function addNotebook() {
  const { body, state } = notebookForm({
    name: '新しいノート',
    color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    paper: 'blank',
    shelfId: shelves[0].id,
    isNew: true,
  });
  const ok = await openDialog({
    title: '新しいノート',
    body,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: '作成', value: true, primary: true, validate: () => state.name.trim() !== '' },
    ],
  });
  if (!ok) return;
  await createNotebook(state.name.trim(), state.color, state.paper, state.shelfId);
  await renderShelf();
}

async function editNotebook(nb) {
  const { body, state } = notebookForm({ name: nb.name, color: nb.color });
  const ok = await openDialog({
    title: 'ノートを編集',
    body,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: '保存', value: true, primary: true, validate: () => state.name.trim() !== '' },
    ],
  });
  if (!ok) return;
  const fresh = await db.get('notebooks', nb.id);
  fresh.name = state.name.trim();
  fresh.color = state.color;
  fresh.updatedAt = Date.now();
  await db.put('notebooks', fresh);
  await renderShelf();
}

async function deleteNotebook(nb) {
  const ok = await confirmDialog(`「${nb.name}」を削除しますか？\nこの操作は元に戻せません。`, '削除', true);
  if (!ok) return;
  await db.deleteNotebook(nb);
  await renderShelf();
  toast('削除しました');
}

async function exportNotebook(nb) {
  const fresh = await db.get('notebooks', nb.id);
  const list = await db.pagesOf(nb.id);
  const byId = new Map(list.map((p) => [p.id, p]));
  const pages = fresh.pageIds.map((id) => byId.get(id)).filter(Boolean);
  await exportPdfFlow(pages, fresh.name);
}

/* ---------- 画面切り替え ---------- */
async function openNotebook(id) {
  const nb = await db.get('notebooks', id);
  if (!nb) return;
  shelfView.classList.add('hidden');
  editorView.classList.remove('hidden');
  await openEditor(nb, { onExit: backToShelf, onExportPdf: exportPdfFlow });
}

async function backToShelf() {
  await closeEditor();
  editorView.classList.add('hidden');
  shelfView.classList.remove('hidden');
  await renderShelf();
}

/* ---------- バックアップ ---------- */
async function exportBackup() {
  const notebooks = await db.getAll('notebooks');
  const pages = await db.getAll('pages');
  const data = { app: 'ipad-note', version: 2, exportedAt: new Date().toISOString(), shelves, notebooks, pages };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const filename = `note-backup-${stamp}.json`;
  await openDialog({
    title: 'バックアップを作成しました',
    message: `ノート ${notebooks.length} 冊（${filename}）\n「ファイル」アプリやiCloud Driveに保存しておくと安心です。`,
    buttons: [
      { label: '閉じる' },
      { label: '保存・共有', primary: true, onClick: () => saveFile(blob, filename) },
    ],
  });
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'ipad-note' || !Array.isArray(data.notebooks) || !Array.isArray(data.pages)) {
      throw new Error('invalid');
    }
    const ok = await confirmDialog(
      `バックアップからノート ${data.notebooks.length} 冊を復元します。\n同じノートがある場合は上書きされます。`,
      '復元',
    );
    if (!ok) return;
    if (Array.isArray(data.shelves)) {
      for (const s of data.shelves) if (!shelves.some((x) => x.id === s.id)) shelves.push(s);
      await saveShelves();
    }
    await db.importAll(data);
    await renderShelf();
    toast('復元しました');
  } catch (e) {
    console.error(e);
    toast('バックアップファイルを読み込めませんでした');
  }
}

/* ---------- 起動 ---------- */
async function init() {
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  $('#menu-backdrop').addEventListener('pointerdown', hideMenu);

  await loadSettings();
  await loadShelves();
  if (!(await db.get('meta', 'seeded'))) {
    const names = ['自由', '仕事', 'アイデア'];
    for (let i = 0; i < names.length; i++) await createNotebook(names[i], COVER_COLORS[i], 'blank');
    await db.put('meta', { key: 'seeded', value: true });
  }

  $('#add-notebook-btn').addEventListener('click', addNotebook);
  $('#shelf-menu-btn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right - 220, r.bottom + 6, [
      { label: '段を追加', action: addShelf },
      '-',
      { label: 'バックアップを書き出す', action: exportBackup },
      { label: 'バックアップから復元', action: () => $('#import-input').click() },
    ]);
  });
  $('#import-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });

  await renderShelf();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
