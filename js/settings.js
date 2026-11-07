import { db } from './db.js';
import { PENS, ERASER } from './render.js';

const DEFAULTS = {
  // 上部に置く2本のペン（よく使う：黒ペン・赤ペン）
  pens: [
    { type: 'ballpoint', color: '#1f1f1f', width: 3.5 },
    { type: 'ballpoint', color: '#d93025', width: 3.5 },
  ],
  activePen: 0,
  eraserWidth: ERASER.def,
  fingerDraw: false,
  shapeSnap: true, // 書き終わりでペンを止めると図形に補正
};

export const settings = JSON.parse(JSON.stringify(DEFAULTS));

function validPen(p) {
  return p && PENS[p.type] && typeof p.color === 'string' && typeof p.width === 'number';
}

export async function loadSettings() {
  const rec = await db.get('meta', 'settings');
  if (!rec) return;
  const v = rec.value || {};
  if (Array.isArray(v.pens) && v.pens.length === 2 && v.pens.every(validPen)) settings.pens = v.pens;
  if (v.activePen === 0 || v.activePen === 1) settings.activePen = v.activePen;
  if (typeof v.eraserWidth === 'number') settings.eraserWidth = v.eraserWidth;
  settings.fingerDraw = !!v.fingerDraw;
  if (typeof v.shapeSnap === 'boolean') settings.shapeSnap = v.shapeSnap;
}

export function saveSettings() {
  db.put('meta', { key: 'settings', value: settings }).catch(console.error);
}

export function currentPen() {
  return settings.pens[settings.activePen];
}
