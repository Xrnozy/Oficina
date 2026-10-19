// Edge routing for the workflow canvas. A line does not use fixed left/right
// ports: each end attaches to whichever side of its node faces the other node,
// so a step below, above, behind or beside another one is joined naturally.
// Lines that share a side are spread along it, and lines going backwards (a
// retry or send-back loop) swing underneath instead of cutting through the
// nodes in between.

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Rect { x: number; y: number; w: number; h: number }
export interface EdgeGeo { sx: number; sy: number; tx: number; ty: number; sp: Side; tp: Side; path: string; mx: number; my: number }
export interface EdgeIn { id: string; source: string; target: string; back?: boolean }

const DIR: Record<Side, [number, number]> = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };
const OPP: Record<Side, Side> = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
const BIAS = 40;          // prefer a horizontal hand-off (the layout flows left to right)
const SPREAD = 20;        // gap between lines that leave the same side
const PAD = 22;           // keep attach points away from the corners

function sidesFor(s: Rect, t: Rect, loop: boolean): [Side, Side] {
  const dx = t.x + t.w / 2 - (s.x + s.w / 2);
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const hgap = Math.abs(dx) - (s.w + t.w) / 2;
  const vgap = Math.abs(dy) - (s.h + t.h) / 2;
  const horizontal = hgap + BIAS >= vgap && hgap > -s.w / 3;
  if (horizontal) {
    if (!loop) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
    // a retry / send-back line: swing underneath, or when the target is on a higher row go up its side (never over the top of other steps)
    return dy < -s.h * 1.5 ? ['top', 'bottom'] : ['bottom', 'bottom'];
  }
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

const mid = (r: Rect, side: Side): [number, number] =>
  side === 'right' ? [r.x + r.w, r.y + r.h / 2] : side === 'left' ? [r.x, r.y + r.h / 2]
    : side === 'top' ? [r.x + r.w / 2, r.y] : [r.x + r.w / 2, r.y + r.h];

function pathFor(sx: number, sy: number, sp: Side, tx: number, ty: number, tp: Side): { path: string; mx: number; my: number } {
  const dist = Math.hypot(tx - sx, ty - sy);
  const k = sp === tp ? Math.min(110, 46 + dist * 0.22) : Math.max(36, Math.min(dist * 0.45, 150));
  const c1: [number, number] = [sx + DIR[sp][0] * k, sy + DIR[sp][1] * k];
  const c2: [number, number] = [tx + DIR[tp][0] * k, ty + DIR[tp][1] * k];
  return {
    path: `M ${sx} ${sy} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${tx} ${ty}`,
    mx: (sx + 3 * c1[0] + 3 * c2[0] + tx) / 8,
    my: (sy + 3 * c1[1] + 3 * c2[1] + ty) / 8,
  };
}

export function layoutEdges(rects: Map<string, Rect>, edges: EdgeIn[]): Map<string, EdgeGeo> {
  type End = { edge: string; which: 's' | 't'; other: number };
  const chosen = new Map<string, [Side, Side]>();
  const slots = new Map<string, End[]>();
  const add = (node: string, side: Side, e: End) => {
    const key = `${node}:${side}`;
    const list = slots.get(key);
    if (list) list.push(e); else slots.set(key, [e]);
  };
  for (const e of edges) {
    const s = rects.get(e.source); const t = rects.get(e.target);
    if (!s || !t || e.source === e.target) continue;
    const [sp, tp] = sidesFor(s, t, !!e.back);
    chosen.set(e.id, [sp, tp]);
    const horiz = (side: Side) => side === 'left' || side === 'right';
    // sort lines on a side by where they are headed, so they fan out without crossing
    const along = (r: Rect, side: Side) => (horiz(side) ? r.y + r.h / 2 : r.x + r.w / 2);
    add(e.source, sp, { edge: e.id, which: 's', other: along(t, sp) });
    add(e.target, tp, { edge: e.id, which: 't', other: along(s, tp) });
  }
  const shift = new Map<string, number>();   // `${edge}:${s|t}` -> offset along the side
  for (const [key, ends] of slots) {
    const node = key.slice(0, key.lastIndexOf(':'));
    const side = key.slice(key.lastIndexOf(':') + 1) as Side;
    const r = rects.get(node)!;
    const room = (side === 'left' || side === 'right' ? r.h : r.w) - PAD * 2;
    const gap = ends.length > 1 ? Math.min(SPREAD, Math.max(6, room / (ends.length - 1))) : 0;
    ends.sort((a, b) => a.other - b.other);
    ends.forEach((x, i) => shift.set(`${x.edge}:${x.which}`, (i - (ends.length - 1) / 2) * gap));
  }
  const out = new Map<string, EdgeGeo>();
  for (const e of edges) {
    const sides = chosen.get(e.id);
    if (!sides) continue;
    const [sp, tp] = sides;
    const s = rects.get(e.source)!; const t = rects.get(e.target)!;
    let [sx, sy] = mid(s, sp); let [tx, ty] = mid(t, tp);
    const so = shift.get(`${e.id}:s`) ?? 0; const to = shift.get(`${e.id}:t`) ?? 0;
    if (sp === 'left' || sp === 'right') sy += so; else sx += so;
    if (tp === 'left' || tp === 'right') ty += to; else tx += to;
    out.set(e.id, { sx, sy, tx, ty, sp, tp, ...pathFor(sx, sy, sp, tx, ty, tp) });
  }
  return out;
}

export const OPPOSITE = OPP;
