/** The part of the screen not covered by UI panels, read from the DOM (`.cmd-left`, `.cmd-right`, `.cmd-top`) so the UI can change its layout freely.
 * Used by the camera (to centre the framing in the free area) and by the label layout (to keep tags clear of the panels). */
export interface Insets { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly width: number; readonly height: number }

export interface RectLike { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly width: number; readonly height: number }

/** Pure: insets for a viewport given the panel rectangles (a panel on the left half insets the left edge, on the right half the right edge, along the top the top edge). */
export function insetsFor(width: number, height: number, panels: readonly RectLike[], pad = 10): Insets {
  let left = 0, right = 0, top = 0;
  for (const r of panels) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.width > width * 0.8 && r.top < height * 0.25) top = Math.max(top, r.bottom + pad);          // top bar
    else if (r.left + r.width / 2 < width / 2) left = Math.max(left, r.right + pad);
    else right = Math.max(right, width - r.left + pad);
  }
  return { left, right, top, bottom: 0, width, height };
}

let cache: { at: number; value: Insets } | null = null;
/** DOM read, cached for 400 ms. */
export function readInsets(width: number, height: number): Insets {
  const now = performance.now();
  if (cache && now - cache.at < 400 && cache.value.width === width && cache.value.height === height) return cache.value;
  const panels: RectLike[] = [];
  for (const sel of ['.cmd-left', '.cmd-right', '.cmd-top']) {
    const el = document.querySelector(sel);
    if (el) { const r = el.getBoundingClientRect(); panels.push(r); }
  }
  const value = insetsFor(width, height, panels);
  cache = { at: now, value };
  return value;
}
