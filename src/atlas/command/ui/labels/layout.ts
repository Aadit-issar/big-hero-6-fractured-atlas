/** Pure label layout: priority-ordered greedy placement in screen space with collision avoidance, sticky sides (hysteresis) and obstacle rectangles.
 * No DOM, no three.js: the label layer feeds it projected anchors and applies the result. Unit-tested (tests/atlasSceneLabels.test.ts). */
export interface Rect { x: number; y: number; w: number; h: number }
export type Side = 'top' | 'right' | 'left' | 'bottom';
export interface LayoutInput {
  readonly key: string;
  readonly priority: number;
  /** Tier 1 labels are always placed (clamped into the free area) when their anchor is on screen. */
  readonly tier: 1 | 2 | 3;
  /** Anchor in pixels and the pixel radius of the object it names (the tag stays outside it). */
  readonly ax: number; readonly ay: number; readonly radius: number;
  readonly w: number; readonly h: number;
}
export interface Placed { readonly key: string; readonly x: number; readonly y: number; readonly side: Side; readonly tier: 1 | 2 | 3 }

export const GAP = 8;
const SIDES: readonly Side[] = ['top', 'right', 'left', 'bottom'];

export function rectFor(c: LayoutInput, side: Side, extra = 0): Rect {
  const off = c.radius + GAP + extra;
  switch (side) {
    case 'top': return { x: c.ax - c.w / 2, y: c.ay - off - c.h, w: c.w, h: c.h };
    case 'bottom': return { x: c.ax - c.w / 2, y: c.ay + off, w: c.w, h: c.h };
    case 'right': return { x: c.ax + off, y: c.ay - c.h / 2, w: c.w, h: c.h };
    default: return { x: c.ax - off - c.w, y: c.ay - c.h / 2, w: c.w, h: c.h };
  }
}
export const overlaps = (a: Rect, b: Rect, pad = 3) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const inside = (r: Rect, free: Rect) => r.x >= free.x && r.y >= free.y && r.x + r.w <= free.x + free.w && r.y + r.h <= free.y + free.h;
const clampInto = (r: Rect, free: Rect): Rect => ({ x: Math.max(free.x, Math.min(free.x + free.w - r.w, r.x)), y: Math.max(free.y, Math.min(free.y + free.h - r.h, r.y)), w: r.w, h: r.h });

/** Places up to `budget` labels. `previous` is the side each key used last time: it is tried first, so a label does not hop between sides frame to frame. */
export function layoutLabels(items: readonly LayoutInput[], free: Rect, obstacles: readonly Rect[], budget: number, previous: ReadonlyMap<string, Side>): Placed[] {
  const order = [...items].sort((a, b) => b.priority - a.priority);
  const taken: Rect[] = [...obstacles];
  const out: Placed[] = [];
  for (const c of order) {
    if (out.length >= budget && c.tier !== 1) continue;
    // Anchors under a panel or off screen are not labelled (tier 1 is nudged into the free area instead when its anchor is merely close to the edge).
    const nearFree = c.ax > free.x - 60 && c.ax < free.x + free.w + 60 && c.ay > free.y - 60 && c.ay < free.y + free.h + 60;
    if (!nearFree) continue;
    const first = previous.get(c.key);
    const sides = first ? [first, ...SIDES.filter(s => s !== first)] : SIDES;
    let chosen: { r: Rect; side: Side } | null = null;
    for (const side of sides) {
      const r = rectFor(c, side);
      if (inside(r, free) && !taken.some(t => overlaps(r, t))) { chosen = { r, side }; break; }
    }
    // Tier 1 must be readable: step further away from the anchor (a short leader) before giving up.
    if (!chosen && c.tier === 1) {
      for (const extra of [26, 52, 78]) {
        for (const side of sides) { const r = rectFor(c, side, extra); if (inside(r, free) && !taken.some(t => overlaps(r, t))) { chosen = { r, side }; break; } }
        if (chosen) break;
      }
    }
    if (!chosen && c.tier === 1) {
      // Must be shown: take the preferred side, clamp into the free area, accept overlap with lower tiers only.
      const side = first ?? 'top';
      chosen = { r: clampInto(rectFor(c, side), free), side };
    }
    if (!chosen) continue;
    taken.push(chosen.r);
    out.push({ key: c.key, x: chosen.r.x, y: chosen.r.y, side: chosen.side, tier: c.tier });
  }
  return out;
}
