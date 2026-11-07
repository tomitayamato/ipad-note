// メニュー・ダイアログ・トースト・長押しなどの共通UI
export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

/* ---------- コンテキストメニュー ---------- */
export function showMenu(x, y, items) {
  const menu = $('#menu');
  const backdrop = $('#menu-backdrop');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      menu.append(el('div', { class: 'menu-sep' }));
      continue;
    }
    menu.append(
      el('button', {
        class: it.danger ? 'danger' : '',
        text: it.label,
        onclick: () => {
          hideMenu();
          it.action();
        },
      }),
    );
  }
  backdrop.classList.remove('hidden');
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(Math.max(8, x), innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(Math.max(8, y), innerHeight - r.height - 8) + 'px';
}

export function hideMenu() {
  $('#menu').classList.add('hidden');
  $('#menu-backdrop').classList.add('hidden');
}

/* ---------- ダイアログ ---------- */
export function openDialog({ title, message, body, buttons }) {
  return new Promise((resolve) => {
    const bd = $('#dialog');
    const box = $('.dialog', bd);
    box.innerHTML = '';
    if (title) box.append(el('h2', { text: title }));
    if (message) box.append(el('p', { class: 'dialog-msg', text: message }));
    if (body) box.append(body);
    const row = el('div', { class: 'dialog-buttons' });
    const close = (value) => {
      bd.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    let primary = null;
    for (const b of buttons) {
      const btn = el('button', {
        class: [b.primary ? 'primary' : '', b.danger ? 'danger' : ''].join(' '),
        text: b.label,
        onclick: () => {
          if (b.validate && !b.validate()) return;
          if (b.onClick) b.onClick(); // ユーザー操作の中で同期実行（共有シートなど）
          close(b.value);
        },
      });
      if (b.primary) primary = btn;
      row.append(btn);
    }
    box.append(row);
    const onKey = (e) => {
      if (e.key === 'Escape') close(undefined);
      if (e.key === 'Enter' && primary && !e.isComposing) primary.click();
    };
    document.addEventListener('keydown', onKey);
    bd.classList.remove('hidden');
    const input = $('input[type=text]', box);
    if (input) setTimeout(() => input.focus(), 50);
  });
}

export async function confirmDialog(message, okLabel = 'OK', danger = false) {
  const v = await openDialog({
    message,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  });
  return v === true;
}

/* ---------- トースト ---------- */
let toastTimer = null;
export function toast(msg, { persist = false } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  const close = () => t.classList.add('hidden');
  if (!persist) toastTimer = setTimeout(close, 2000);
  return { update: (m) => (t.textContent = m), close };
}

/* ---------- 長押し ---------- */
export function longPress(target, { onTap, onLong, delay = 500 }) {
  let timer = null;
  let sx = 0, sy = 0, fired = false, active = false;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
    target.classList.remove('pressed');
  };
  target.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    sx = e.clientX;
    sy = e.clientY;
    fired = false;
    active = true;
    target.classList.add('pressed');
    timer = setTimeout(() => {
      fired = true;
      target.classList.remove('pressed');
      onLong(sx, sy);
    }, delay);
  });
  target.addEventListener('pointermove', (e) => {
    if (active && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
      active = false;
      clear();
    }
  });
  target.addEventListener('pointerup', () => {
    const wasActive = active;
    active = false;
    clear();
    if (wasActive && !fired && onTap) onTap();
  });
  target.addEventListener('pointercancel', () => {
    active = false;
    clear();
  });
  target.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!fired) {
      fired = true;
      active = false;
      clear();
      onLong(e.clientX, e.clientY);
    }
  });
}

/* ---------- ファイル保存（iPadでは共有シート → 「ファイルに保存」） ---------- */
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function safeFileName(name) {
  return (name || 'note').replace(/[\\/:*?"<>|]/g, '_').trim() || 'note';
}
