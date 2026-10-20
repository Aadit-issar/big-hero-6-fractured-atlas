import { describe, expect, it } from 'vitest';
import { layoutLabels, overlaps } from '../src/atlas/command/ui/labels/layout';
import type { LayoutInput, Rect, Side } from '../src/atlas/command/ui/labels/layout';
import { classify, labelBudget } from '../src/atlas/command/ui/labels/policy';
import type { EntityFacts } from '../src/atlas/command/ui/labels/policy';
import { insetsFor } from '../src/atlas/command/camera/insets';
import { buildEnvelope } from '../src/atlas/command/scene/envelope';

const facts = (o: Partial<EntityFacts>): EntityFacts => ({ kind: 'wreckage', remembered: false, moving: false, foldState: null, selected: false, objective: false, related: false, distance: 20, ...o });
const FREE: Rect = { x: 300, y: 80, w: 1250, h: 900 };
const item = (key: string, ax: number, ay: number, priority: number, tier: 1 | 2 | 3 = 2): LayoutInput => ({ key, priority, tier, ax, ay, radius: 10, w: 120, h: 24 });

describe('label policy', () => {
  it('rubble is hidden by default and revealed by showAllLabels (tier 3)', () => {
    expect(classify(facts({ kind: 'wreckage' }), false, false)).toBeNull();
    expect(classify(facts({ kind: 'debris' }), false, true)!.tier).toBe(3);
  });
  it('selection, objective and critical folds are tier 1; islands and mission objects tier 2', () => {
    expect(classify(facts({ selected: true }), false, false)!.tier).toBe(1);
    expect(classify(facts({ objective: true }), false, false)!.tier).toBe(1);
    expect(classify(facts({ kind: 'fold', foldState: 'unstable' }), false, false)!.tier).toBe(1);
    expect(classify(facts({ kind: 'island' }), false, false)!.tier).toBe(2);
    expect(classify(facts({ kind: 'capsule' }), false, false)!.priority).toBeGreaterThan(classify(facts({ kind: 'equipment' }), false, false)!.priority);
  });
  it('focus mode keeps only related labels', () => {
    expect(classify(facts({ kind: 'island' }), true, false)).toBeNull();
    expect(classify(facts({ kind: 'island', related: true }), true, false)!.tier).toBe(2);
  });
  it('the budget shrinks when zoomed out and grows when inspecting', () => {
    expect(labelBudget('overview', 300, false)).toBeLessThan(labelBudget('overview', 100, false));
    expect(labelBudget('overview', 100, true)).toBeGreaterThan(labelBudget('overview', 100, false));
  });
});

describe('label layout', () => {
  it('never overlaps two placed labels and respects the budget', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`k${i}`, 600 + (i % 6) * 40, 400 + Math.floor(i / 6) * 20, 500 - i));
    const out = layoutLabels(items, FREE, [], 8, new Map());
    expect(out.length).toBeLessThanOrEqual(8);
    const rects = out.map(p => ({ x: p.x, y: p.y, w: 120, h: 24 }));
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i]!, rects[j]!, 0)).toBe(false);
  });
  it('higher priority wins a contested spot and tier 1 is always placed', () => {
    const out = layoutLabels([item('low', 700, 500, 100), item('high', 700, 500, 900, 1)], FREE, [], 1, new Map());
    expect(out.map(p => p.key)).toContain('high');
  });
  it('stays out of obstacles (Baymax body) and keeps clear of panels', () => {
    const body: Rect = { x: 660, y: 440, w: 80, h: 80 };
    const out = layoutLabels([item('a', 700, 480, 500)], FREE, [body], 5, new Map());
    for (const p of out) expect(overlaps({ x: p.x, y: p.y, w: 120, h: 24 }, body, 0)).toBe(false);
    expect(layoutLabels([item('under-panel', 100, 500, 500, 2)], FREE, [], 5, new Map())).toHaveLength(0);
  });
  it('is sticky: a label keeps its previous side while it fits', () => {
    const prev = new Map<string, Side>([['a', 'right']]);
    expect(layoutLabels([item('a', 700, 500, 500)], FREE, [], 5, prev)[0]!.side).toBe('right');
  });
  it('panel insets come from rectangles', () => {
    const i = insetsFor(1920, 1080, [{ left: 12, right: 302, top: 75, bottom: 900, width: 290, height: 825 }, { left: 1558, right: 1908, top: 75, bottom: 900, width: 350, height: 825 }, { left: 12, right: 1908, top: 12, bottom: 62, width: 1896, height: 50 }]);
    expect(i.left).toBeGreaterThan(300); expect(i.right).toBeGreaterThan(350); expect(i.top).toBeGreaterThan(62);
  });
});

describe('uncertainty envelope', () => {
  it('has radius equal to the stated uncertainty at every sample and widens with it', () => {
    const pts = Array.from({ length: 12 }, (_, i) => [i * 2, Math.sin(i / 3), 0] as const);
    const radii = pts.map((_, i) => 0.3 + 0.4 * i);
    const m = buildEnvelope(pts, radii, 10);
    for (let i = 0; i < pts.length; i += 1) for (let s = 0; s < 10; s += 1) {
      const k = (i * 10 + s) * 3;
      expect(Math.hypot(m.positions[k]! - pts[i]![0], m.positions[k + 1]! - pts[i]![1], m.positions[k + 2]! - pts[i]![2])).toBeCloseTo(radii[i]!, 4);
    }
    expect(m.indices.length).toBe(11 * 10 * 6);
  });
});
