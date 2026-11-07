import { db } from './db.js';

const DEFAULTS = {
  pen: {
    type: 'ballpoint',
    ballpoint: { color: '#1f1f1f', widthIdx: 1 },
    magic: { color: '#1a73e8', widthIdx: 1 },
    marker: { color: '#f9ab00', widthIdx: 1 },
  },
  favorites: [],
  fingerDraw: false,
};

export const settings = JSON.parse(JSON.stringify(DEFAULTS));

export async function loadSettings() {
  const rec = await db.get('meta', 'settings');
  if (!rec) return;
  const v = rec.value || {};
  Object.assign(settings.pen, v.pen || {});
  for (const k of ['ballpoint', 'magic', 'marker']) {
    settings.pen[k] = { ...DEFAULTS.pen[k], ...(v.pen && v.pen[k]) };
  }
  settings.favorites = Array.isArray(v.favorites) ? v.favorites : [];
  settings.fingerDraw = !!v.fingerDraw;
}

export function saveSettings() {
  db.put('meta', { key: 'settings', value: settings }).catch(console.error);
}

export function currentPen() {
  const type = settings.pen.type;
  return { type, ...settings.pen[type] };
}
