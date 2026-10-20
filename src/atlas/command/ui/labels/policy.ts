import type { CameraMode } from '../../scene/sceneApi';

/** Which entities are labelled, and how important each label is. Pure and tested.
 *   TIER 1  always, when relevant: Baymax, the selection, the current navigation objective, planned rendezvous / aim point, critical folds, warnings.
 *   TIER 2  by zoom and relevance: major islands, mission objects (capsule, armour), active folds, moving objects.
 *   TIER 3  generic rubble, small fragments, repeated debris: hidden (aggregated into a count) unless `showAllLabels`. */
export interface EntityFacts {
  readonly kind: 'island' | 'fold' | 'capsule' | 'equipment' | 'debris' | 'wreckage' | 'swarm';
  readonly remembered: boolean;
  readonly moving: boolean;
  readonly foldState: string | null;
  readonly selected: boolean;
  /** The navigation objective (route target) or the plan's destination. */
  readonly objective: boolean;
  /** An obstacle the plan avoided / a fold related to the selection. */
  readonly related: boolean;
  /** Distance from Baymax (m). */
  readonly distance: number;
}
export interface Policy { readonly tier: 1 | 2 | 3; readonly priority: number }

export const CRITICAL_FOLD = new Set(['unstable']);
const ACTIVE_FOLD = new Set(['open', 'unstable', 'forming', 'closing']);

export function classify(f: EntityFacts, focusActive: boolean, showAll: boolean): Policy | null {
  const near = Math.max(0, 60 - f.distance / 4); // 0..60 bonus for nearby things
  if (f.selected) return { tier: 1, priority: 1000 };
  if (f.objective) return { tier: 1, priority: 940 };
  if (f.kind === 'fold' && f.foldState && CRITICAL_FOLD.has(f.foldState) && !f.remembered) return { tier: 1, priority: 880 + near / 10 };
  // While something is selected in Predict/Route, unrelated labels fade out; related obstacles and folds stay identifiable.
  if (focusActive) return f.related ? { tier: 2, priority: 600 + near } : null;
  if (f.kind === 'island') return { tier: 2, priority: 540 + near };
  if (f.kind === 'capsule') return { tier: 2, priority: 580 + (f.moving ? 60 : 0) + near };
  if (f.kind === 'equipment') return { tier: 2, priority: 470 + (f.moving ? 40 : 0) + near };
  if (f.kind === 'fold') return f.foldState && ACTIVE_FOLD.has(f.foldState) ? { tier: 2, priority: 500 + near } : showAll ? { tier: 3, priority: 100 + near } : null;
  if (f.moving) return { tier: 2, priority: 520 + near };
  if (showAll) return { tier: 3, priority: 120 + near };
  return null;
}

/** How many labels may be on screen at once, by camera mode and zoom (camera distance in metres). Tier 1 always counts but is never dropped. */
export function labelBudget(mode: CameraMode | undefined, distance: number, showAll: boolean): number {
  let n = mode === 'follow' ? 5 : mode === 'focus' ? 6 : mode === 'route' || mode === 'prediction' || mode === 'interception' ? 8 : 7;
  if (distance > 220) n -= 2; else if (distance < 40) n += 1;
  if (showAll) n += 24;
  return Math.max(4, n);
}
