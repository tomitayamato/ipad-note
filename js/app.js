// エントリーポイント：本棚画面と画面切り替え、バックアップ
import { db, uid } from './db.js';
import { loadSettings } from './settings.js';
import { PAPERS } from './render.js';
import { $, el, showMenu, hideMenu, openDialog, confirmDialog, toast, longPress, saveFile } from './ui.js';
import { openEditor, closeEditor } from './editor.js';
import { exportPdfFlow } from './pdf.js';

export const COVER_COLORS = ['#b23a48', '#2d6a8f', '#3c7a4a', '#c47f2c', '#6a4c93', '#2f3e46', '#b5838d', '#8d6e63'];

const shelfView = $('#shelf-view');
const editorView = $('#editor-view');
const shelfEl = $('#shelf');

async function createNotebook(name, color, paper) {
  const now = Date.now();
  const nb = { id: uid(), name, color, pageIds: [], createdAt: now, updatedAt: now, lastPage: 0 };
  const page = { id: uid(), notebookId: nb.id, paper, strokes: [], createdAt: now };
  nb.pageIds = [page.id];
  await db.put('pages', page);
  await db.put('notebooks', nb);
  return nb;
}

/* ---------- 本棚 ---------- */
async function renderShelf() {
  const nbs = (await db.getAll('notebooks')).sort((a, b) => a.createdAt - b.createdAt);
  shelfEl.innerHTML = '';
  if (!nbs.length) {
    shelfEl.append(el('div', { class: 'shelf-empty', text: '右上の ＋ から新しいノートを作成しましょう' }));
    return;
  }
  for (const nb of nbs) {
    const book = el('div', { class: 'book', style: `--cover:${nb.color}` }, [
      el('div', { class: 'book-label' }, el('span', { class: 'book-title', text: nb.name })),
      el('div', { class: 'book-meta', text: `${nb.pageIds.length} ページ` }),
    ]);
    longPress(book, {
      onTap: () => openNotebook(nb.id),
      onLong: (x, y) => bookMenu(nb, x, y),
    });
    shelfEl.append(book);
  }
}

function bookMenu(nb, x, y) {
  showMenu(x, y, [
    { label: '名前・表紙を編集', action: () => editNotebook(nb) },
    { label: '1冊まるごとPDFに書き出し', action: () => exportNotebook(nb) },
    '-',
    { label: '削除', danger: true, action: () => deleteNotebook(nb) },
  ]);
}

function notebookForm({ name, color, paper, isNew }) {
  const state = { name, color, paper };
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

  if (isNew) {
    const seg = el('div', { class: 'seg' });
    const drawSeg = () => {
      seg.innerHTML = '';
      for (const [k, label] of Object.entries(PAPERS)) {
        seg.append(
          el('button', {
            class: k === state.paper ? 'active' : '',
            text: label,
            onclick: () => {
              state.paper = k;
              drawSeg();
            },
          }),
        );
      }
    };
    drawSeg();
    body.append(el('div', { class: 'field' }, [el('span', { text: '用紙' }), seg]));
  }
  return { body, state };
}

async function addNotebook() {
  const { body, state } = notebookForm({
    name: '新しいノート',
    color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    paper: 'blank',
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
  await createNotebook(state.name.trim(), state.color, state.paper);
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
  const data = { app: 'ipad-note', version: 1, exportedAt: new Date().toISOString(), notebooks, pages };
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
  if (!(await db.get('meta', 'seeded'))) {
    const names = ['自由', '仕事', 'アイデア'];
    for (let i = 0; i < names.length; i++) {
      await createNotebook(names[i], COVER_COLORS[i], 'blank');
      await new Promise((r) => setTimeout(r, 2)); // 作成順を保つ
    }
    await db.put('meta', { key: 'seeded', value: true });
  }

  $('#add-notebook-btn').addEventListener('click', addNotebook);
  $('#shelf-menu-btn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right - 220, r.bottom + 6, [
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
