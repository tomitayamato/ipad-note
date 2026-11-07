// 図形の自動補正：手書きの線・円・楕円・四角・三角をきれいな形に置き換える
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Ramer–Douglas–Peucker（折れ線の簡略化）
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  let idx = -1;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], a, b);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function angleAt(p, v, n) {
  const ax = p[0] - v[0], ay = p[1] - v[1];
  const bx = n[0] - v[0], by = n[1] - v[1];
  const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

// ほぼ一直線上の頂点・近すぎる頂点を取り除く（閉じた多角形）
function cleanCorners(corners, minGap) {
  let cs = corners.slice();
  let changed = true;
  while (changed && cs.length > 3) {
    changed = false;
    for (let i = 0; i < cs.length; i++) {
      const p = cs[(i - 1 + cs.length) % cs.length];
      const v = cs[i];
      const n = cs[(i + 1) % cs.length];
      if (angleAt(p, v, n) > 150 || dist(p, v) < minGap) {
        cs.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return cs;
}

// 直線をなぞって細かい点にする（角がシャープに見えるように）
function sample(poly, closed) {
  const out = [];
  const list = closed ? poly.concat([poly[0]]) : poly;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    const n = Math.max(1, Math.ceil(dist(a, b) / 3));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(list[list.length - 1].slice());
  return out;
}

function snapAngle(a, b) {
  const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const near = Math.round(ang / 90) * 90;
  if (Math.abs(ang - near) > 5) return b;
  const len = dist(a, b);
  const r = (near * Math.PI) / 180;
  return [a[0] + Math.cos(r) * len, a[1] + Math.sin(r) * len];
}

/** 認識できたら新しい点列（[x, y, 筆圧]）を返す。できなければ null */
export function recognizeShape(points) {
  const pts = points.map((p) => [p[0], p[1]]);
  if (pts.length < 4) return null;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1], pts[i]);
  if (length < 40) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);
  const withP = (list) => list.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.5]);

  // 直線
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, distToSeg(p, a, b));
  if (chord > 30 && maxDev < Math.max(4, chord * 0.06)) {
    return withP(sample([a, snapAngle(a, b)], false));
  }

  // ここから先は「閉じた図形」だけ
  if (chord > Math.max(30, diag * 0.3)) return null;

  const corners = cleanCorners(rdp(pts, diag * 0.07).slice(0, -1), diag * 0.08);
  const w = x1 - x0;
  const h = y1 - y0;

  // 四角（ほぼ水平・垂直）：4つの角が外接矩形の四隅の近くにある
  if (corners.length === 4) {
    const box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const used = new Set();
    const ok = corners.every((c) => {
      let best = -1;
      let bd = Infinity;
      box.forEach((q, i) => {
        const d = dist(c, q);
        if (!used.has(i) && d < bd) {
          bd = d;
          best = i;
        }
      });
      used.add(best);
      return bd < diag * 0.12;
    });
    if (ok) return withP(sample(box, true));
  }

  // 円・楕円
  if (w > 10 && h > 10) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let rx = w / 2;
    let ry = h / 2;
    let err = 0;
    for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    err /= pts.length;
    if (err < 0.1) {
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) rx = ry = (rx + ry) / 2;
      const start = Math.atan2((a[1] - cy) / ry, (a[0] - cx) / rx);
      const n = Math.max(48, Math.round((Math.PI * (rx + ry)) / 3));
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t = start + (i / n) * Math.PI * 2;
        out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
      }
      return withP(out);
    }
  }

  // 三角・四角（斜め）
  if (corners.length === 3 || corners.length === 4) return withP(sample(corners, true));
  return null;
}
