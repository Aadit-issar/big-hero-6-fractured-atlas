import type { AtlasView } from '../core/runtime';
import type { ForecastEvaluation } from '../analysis/types';
import type { WorldVec3 } from '../../shared/atlasContract';
import type { ForecastArchiveEntry } from '../scene/sceneModel';

/** Read-only facts derived from ATLAS's own records, phrased for people. Nothing here reads simulation ground truth,
 * and nothing is computed from observations that had not been delivered at the view's time. */

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** An allowance of exactly zero is real (steady motion fits a straight line exactly), but "0.000" reads as missing data. */
export function formatAllowance(value: number): string {
  return `± ${value < 0.0005 ? '0.000' : value.toFixed(3)}`;
}
export const formatUnits = (value: number) => (value < 0.0005 ? '0.000' : value.toFixed(3));

/** What the "estimates evaluated" count of the old summary actually counted: every published forecast of every analysed quantity,
 * issued at every 0.25 s observation, as overlapping 1 s forecasts, capped at the runtime's evaluation window. Not independent events.
 * The meaningful, defensible tally is per quantity, over distinct forecasts (unique issue times), reported with its misses. */
export interface ForecastScoreboard {
  readonly key: string;
  /** Distinct published forecasts of this quantity that have been compared with a later observation. */
  readonly scored: number;
  readonly withinAllowance: number;
  readonly missed: number;
  /** Forecasts closer to the later observation than the "nothing moved" guess. */
  readonly beatNoChange: number;
  /** Largest miss, in world units. */
  readonly worstError: number;
  /** True when the runtime's evaluation window may have discarded older records, so the tally can undercount. */
  readonly windowFull: boolean;
}

export function forecastScoreboard(view: AtlasView, key: string): ForecastScoreboard {
  const seen = new Set<number>();
  const rows: ForecastEvaluation[] = [];
  for (const e of view.temporal.evaluations) {
    if (e.key !== key || !e.published || seen.has(e.issuedAt)) continue;
    seen.add(e.issuedAt); rows.push(e);
  }
  return {
    key, scored: rows.length,
    withinAllowance: rows.filter(e => e.covered).length,
    missed: rows.filter(e => !e.covered).length,
    beatNoChange: rows.filter(e => e.error < e.persistenceError).length,
    worstError: rows.reduce((m, e) => Math.max(m, e.error), 0),
    windowFull: view.temporal.evaluations.length >= view.temporal.policy.evaluationLimit,
  };
}

/** One forecast presented as a story: what was measured, what ATLAS published, and what was measured later. All from records. */
export interface ForecastStory {
  readonly key: string;
  readonly foldId: string;
  readonly issuedAt: number;
  readonly targetTime: number;
  readonly allowance: number;
  /** Measured positions up to the issue time (the evidence the forecast used), as distance along the forecast's direction. */
  readonly measured: readonly { readonly t: number; readonly s: number }[];
  readonly estimate: { readonly t: number; readonly s: number };
  /** The measurement at the target time, if it has been delivered. */
  readonly arrival: { readonly t: number; readonly s: number } | null;
  /** The comparison, once ATLAS has made it. Uses the forecast's own allowance. */
  readonly check: { readonly error: number; readonly allowance: number; readonly covered: boolean; readonly noChangeError: number; readonly evaluatedAt: number } | null;
  readonly pathUnit: WorldVec3;
  readonly speed: number;
}

export function forecastStory(view: AtlasView, archive: readonly ForecastArchiveEntry[], foldId: string, issuedAt: number): ForecastStory | null {
  const fold = view.mapping.folds.find(f => f.id === foldId);
  const entry = archive.find(p => p.key === `fold:${foldId}:entry` && p.forecast.issuedAt === issuedAt);
  if (!fold || !entry) return null;
  const f = entry.forecast;
  const used = fold.track.filter(s => s.time <= issuedAt + 1e-9 && s.time >= issuedAt - view.temporal.policy.windowSamples * 0.25);
  const origin = used[0]?.entryPosition ?? fold.lastKnownEntryPosition;
  const est: WorldVec3 = [f.estimate[0]!, f.estimate[1]!, f.estimate[2]!];
  const length = dist(origin, est) || 1;
  const unit: WorldVec3 = [(est[0] - origin[0]) / length, (est[1] - origin[1]) / length, (est[2] - origin[2]) / length];
  const along = (p: readonly number[]) => (p[0]! - origin[0]) * unit[0] + (p[1]! - origin[1]) * unit[1] + (p[2]! - origin[2]) * unit[2];
  const arrivalSample = fold.track.find(s => Math.abs(s.time - f.targetTime) < 1e-9);
  const ev = view.temporal.evaluations.find(e => e.key === entry.key && e.published && e.issuedAt === issuedAt && e.targetTime === f.targetTime);
  return {
    key: entry.key, foldId, issuedAt, targetTime: f.targetTime, allowance: f.errorAllowance,
    measured: used.map(s => ({ t: s.time, s: along(s.entryPosition) })),
    estimate: { t: f.targetTime, s: along(est) },
    arrival: arrivalSample ? { t: arrivalSample.time, s: along(arrivalSample.entryPosition) } : null,
    check: ev ? { error: ev.error, allowance: ev.errorAllowance, covered: ev.covered, noChangeError: ev.persistenceError, evaluatedAt: ev.evaluatedAt } : null,
    pathUnit: unit,
    speed: (along(est) - (used.at(-1) ? along(used.at(-1)!.entryPosition) : 0)) / Math.max(1e-9, f.targetTime - issuedAt),
  };
}

/** The engine's own withholding reasons, in everyday words. */
export function plainReason(reason: string | undefined): string {
  if (!reason) return 'There are not enough current measurements to estimate from.';
  const need = /Need (\d+) contiguous samples over (\d+(?:\.\d+)?) model second/.exec(reason);
  if (need) return `ATLAS needs ${need[1]} fresh, uninterrupted measurements spanning ${need[2]} s before it will estimate.`;
  if (reason.startsWith('Not in the current sensor observation')) return 'The fold is not in the current observation, so its motion is unknown.';
  return reason;
}
