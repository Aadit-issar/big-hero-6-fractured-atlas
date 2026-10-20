import type { NavOutcome, RouteMode } from '../../../../shared/liveLink';
import type { CommandSnapshot, RouteView } from '../../session';
import type { Encounter, ForecastView } from '../../encounter';
import type { Vec3 } from '../../world';

/** Pure presentation logic for the ATLAS Command panels: one shared time language, plain-words model validity, route stages and the measured
 * outcome. Everything is derived from the snapshot; no number here is a constant. */

export const f1 = (n: number) => n.toFixed(1);
export const f0 = (n: number) => n.toFixed(0);
export const vec = (v: readonly number[]) => v.map(x => { const r = Math.round(x); return String(r === 0 ? 0 : r); }).join(', ');
export const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

// ---------- time language ----------
/** "NOW" or "IN 4.2 s": the only way a future time is written anywhere in the UI. */
export function inSeconds(t: number, now: number): string {
  const d = t - now;
  return d < 0.05 ? 'NOW' : `IN ${d.toFixed(1)} s`;
}

export interface TimeMarker { readonly key: 'now' | 'scrub' | 'eta' | 'intercept' | 'trusted'; readonly t: number; readonly label: string }

/** Markers for the time rail. When Baymax's ETA and the planned interception are the same time they are one marker ("ETA = INTERCEPT"), never two
 * that could be mistaken for different moments. */
export function timeMarkers(now: number, opts: { eta?: number | null; aim?: number | null; scrub?: number | null; trustedUntil?: number | null }): TimeMarker[] {
  const out: TimeMarker[] = [{ key: 'now', t: now, label: 'NOW' }];
  if (opts.scrub != null) out.push({ key: 'scrub', t: opts.scrub, label: `PREVIEW ${inSeconds(opts.scrub, now)}` });
  const eta = opts.eta ?? null, aim = opts.aim ?? null;
  if (eta != null && aim != null && Math.abs(eta - aim) < 0.25) out.push({ key: 'intercept', t: eta, label: `ETA = INTERCEPT ${inSeconds(eta, now)}` });
  else {
    if (eta != null) out.push({ key: 'eta', t: eta, label: `BAYMAX ETA ${inSeconds(eta, now)}` });
    if (aim != null) out.push({ key: 'intercept', t: aim, label: `AIM POINT ${inSeconds(aim, now)}` });
  }
  if (opts.trustedUntil != null) out.push({ key: 'trusted', t: opts.trustedUntil, label: `TRUSTED ${inSeconds(opts.trustedUntil, now)}` });
  return out.sort((a, b) => a.t - b.t);
}

// ---------- connection ----------
export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export function connectionPill(s: Pick<CommandSnapshot, 'link' | 'clock' | 'simTime'>): { text: string; tone: Tone; detail: string } {
  const t = `t ${f1(s.simTime)} s`;
  switch (s.link.status) {
    case 'connected':
      if (s.clock && !s.clock.running) return { text: 'PAUSED', tone: 'warn', detail: t };
      if (s.clock && !s.clock.visible) return { text: 'LIVE', tone: 'warn', detail: `${t} · Dimension tab hidden` };
      return { text: 'LIVE', tone: 'ok', detail: t };
    case 'stale': return { text: 'STALE', tone: 'warn', detail: `${t} · last data` };
    case 'disconnected': return { text: 'DISCONNECTED', tone: 'bad', detail: s.simTime > 0 ? `last ${t}` : 'no link' };
    case 'connecting': return { text: 'CONNECTING', tone: 'warn', detail: 'waiting' };
    default: return { text: 'NOT CONNECTED', tone: 'idle', detail: 'no link' };
  }
}

// ---------- plan type ----------
export function planBadge(mode: RouteMode | undefined): { text: string; hint: string } {
  switch (mode) {
    case 'intercept': return { text: 'INTERCEPT', hint: 'Meet a moving target where it will be' };
    case 'entrance': return { text: 'INVESTIGATE FOLD', hint: 'Fly to the fold entrance; where it leads is not observed' };
    case 'approach': return { text: 'APPROACH', hint: 'Fly to a point beside a stationary destination' };
    default: return { text: 'NAVIGATE', hint: 'Fly to the last known position and re-observe' };
  }
}

// ---------- predictive: scrubber and validity ----------
export interface ScrubReadout { readonly offset: number; readonly max: number; readonly label: string; readonly position: Vec3; readonly uncertainty: number; readonly trusted: boolean }
/** The forecast preview at `offset` seconds after now, clamped to [0, trustedUntil - now]. It is a read of the forecast, never of the world. */
export function scrubReadout(forecast: ForecastView, offset: number): ScrubReadout {
  const max = Math.max(0.5, forecast.trustedUntil - forecast.now);
  const o = Math.max(0, Math.min(max, offset));
  const p = forecast.at(forecast.now + o);
  return { offset: o, max, label: inSeconds(forecast.now + o, forecast.now), position: p.position, uncertainty: p.uncertainty, trusted: forecast.now + o <= forecast.trustedUntil + 1e-6 };
}

export interface Validity { readonly headline: string; readonly lines: readonly string[]; readonly tone: 'good' | 'limited' | 'none' }
/** What the forecast stands on, in plain words, from the estimate and the track. */
export function validityOf(input: { observations: number; span: number; evidenceAge: number; ok: boolean; motion: string; model: string | null; note: string | null; heldOutError: number | null; baselineError: number | null; leadSeconds: number | null }): Validity {
  const lines: string[] = [`${input.observations} observation${input.observations === 1 ? '' : 's'} over ${f1(input.span)} s; newest ${f1(input.evidenceAge)} s old.`];
  if (!input.ok) return { headline: 'Not enough evidence to forecast yet', lines: [...lines, input.note ?? 'More observations are needed.'], tone: 'none' };
  if (input.motion !== 'moving') return { headline: 'It has not moved while observed', lines: [...lines, 'There is nothing to forecast; ATLAS plans to its observed position.'], tone: 'limited' };
  lines.push(`Model: ${input.model ?? 'unknown'}.`);
  if (input.heldOutError != null && input.baselineError != null) {
    lines.push(`Tested on held-out observations ${input.leadSeconds != null ? `${f1(input.leadSeconds)} s ahead` : 'ahead'}: off by ${f1(input.heldOutError)} m, versus ${f1(input.baselineError)} m if it were assumed not to move.`);
    return { headline: input.heldOutError < input.baselineError ? 'Forecast beats "it has not moved"' : 'Forecast is no better than "it has not moved"', lines, tone: input.heldOutError < input.baselineError ? 'good' : 'limited' };
  }
  return { headline: 'Forecast available, not yet validated', lines: [...lines, 'Too few observations were held out to measure its error.'], tone: 'limited' };
}

// ---------- route: encounter summary ----------
export interface EncounterSummary {
  readonly moving: boolean;
  readonly etaIn: string;
  readonly targetTimeIn: string;
  readonly sameTime: boolean;
  readonly rendezvous: Vec3;
  readonly travel: number;
  readonly aheadOfNow: number;
  readonly validity: string;
  readonly sentence: string;
}
export function encounterSummary(e: Encounter): EncounterSummary {
  const travel = e.arrivalTime - e.now;
  const rendezvous = e.moving ? e.targetAtAim.position : e.baymaxAtArrival;
  const aheadOfNow = e.moving ? dist(e.targetNow.position, e.targetAtAim.position) : 0;
  const sameTime = Math.abs(e.arrivalTime - e.aimTime) < 0.25;
  let validity: string;
  if (!e.moving) validity = 'Stationary destination; approach point is on the observed position.';
  else if (e.converged && !e.leadLimited) validity = `Converged: Baymax and ${e.label} meet within ${f1(e.gap)} m; position uncertain by ±${f1(e.targetAtAim.uncertainty)} m.`;
  else validity = `Aim point only: the forecast is trusted only up to ${inSeconds(e.aimTime, e.now)}, so Baymax is aimed there and arrives ${f1(e.gap)} m from where ${e.label} is then expected.`;
  const sentence = e.moving
    ? (e.converged && !e.leadLimited
      ? `ATLAS routes Baymax to where ${e.label} will be at arrival, not to where it is now.`
      : `ATLAS aims Baymax at where ${e.label} is forecast to be ${inSeconds(e.aimTime, e.now).toLowerCase()}, not where it is now; the forecast cannot yet be trusted all the way to arrival.`)
    : `${e.label} is not forecast to move, so Baymax is routed to an approach point beside its observed position.`;
  return { moving: e.moving, etaIn: inSeconds(e.arrivalTime, e.now), targetTimeIn: sameTime ? inSeconds(e.arrivalTime, e.now) : inSeconds(e.aimTime, e.now), sameTime, rendezvous, travel, aheadOfNow, validity, sentence };
}

// ---------- route: state strip and outcome ----------
export type StageKey = 'sent' | 'accepted' | 'flying' | 'result';
export interface RouteStages {
  readonly steps: readonly { readonly key: StageKey; readonly label: string; readonly done: boolean; readonly current: boolean }[];
  readonly terminal: 'arrived' | 'missed' | 'rejected' | 'cancelled' | null;
  readonly progress: number | null;
  readonly remaining: number | null;
}

export function routeStages(route: RouteView): RouteStages | null {
  if (route.state === 'none') return null;
  const nav = route.nav;
  const terminal = route.state === 'arrived' || route.state === 'missed' || route.state === 'rejected' || route.state === 'cancelled' ? route.state : null;
  const accepted = route.state !== 'sent' && route.state !== 'rejected';
  const flying = accepted && !!nav && nav.status === 'active';
  const finished = route.state === 'arrived' || route.state === 'missed';
  const current: StageKey = finished ? 'result' : flying ? 'flying' : accepted ? 'accepted' : 'sent';
  const order: StageKey[] = ['sent', 'accepted', 'flying', 'result'];
  const labels: Record<StageKey, string> = { sent: 'Sent', accepted: 'Accepted', flying: 'Flying', result: route.state === 'missed' ? 'Missed' : route.state === 'arrived' ? 'Arrived' : 'Arrival' };
  const idx = order.indexOf(current);
  const steps = order.map((key, i) => ({ key, label: labels[key], done: i < idx || (finished && i === idx), current: i === idx && !finished }));
  let progress: number | null = null, remaining: number | null = null;
  if (nav) {
    remaining = nav.distanceToGoal;
    const wps = route.active?.waypoints ?? [];
    let total = 0;
    for (let i = 1; i < wps.length; i += 1) total += dist(wps[i - 1]!, wps[i]!);
    if (route.state === 'arrived') progress = 1;
    else if (total > 1) progress = Math.max(0, Math.min(1, 1 - nav.distanceToGoal / total));
  }
  return { steps, terminal, progress, remaining };
}

export interface OutcomeView {
  readonly success: boolean;
  readonly title: string;
  readonly rows: readonly { readonly k: string; readonly v: string; readonly tone?: 'good' | 'warn' }[];
  readonly note: string;
}
/** The measured result of a finished route (decided in the Dimension from true positions). Null until the Dimension reports an outcome. */
export function outcomeView(route: RouteView): OutcomeView | null {
  const o: NavOutcome | undefined = route.nav?.outcome;
  if (!o || !route.nav || (route.nav.status !== 'arrived' && route.nav.status !== 'missed')) return null;
  const intercept = o.plannedPosition !== null;
  const corrections = Math.max(0, route.history.length - 1);
  const rows: { k: string; v: string; tone?: 'good' | 'warn' }[] = [
    { k: 'Closest approach', v: `${f1(o.closestApproach)} m (capture radius ${f1(o.captureRadius)} m)`, tone: o.success ? 'good' : 'warn' },
    { k: o.success ? 'Encounter time' : 'Decided at', v: `t ${f1(o.simTime)} s` },
  ];
  if (intercept && o.plannedSimTime !== null) rows.push({ k: 'Predicted time', v: `t ${f1(o.plannedSimTime)} s (${o.simTime - o.plannedSimTime >= 0 ? '+' : '−'}${f1(Math.abs(o.simTime - o.plannedSimTime))} s)` });
  if (intercept && o.plannedError !== null) rows.push({ k: 'Prediction error', v: `${f1(o.plannedError)} m between the planned meeting point and where it truly was` });
  if (intercept) rows.push({ k: 'Route corrections', v: String(corrections) });
  const title = o.success ? (intercept ? 'RENDEZVOUS ACHIEVED' : 'ARRIVED AT DESTINATION') : (intercept ? 'RENDEZVOUS MISSED' : 'DESTINATION MISSED');
  const note = o.success ? 'Measured by the Dimension from true positions.' : `Baymax came within ${f1(o.closestApproach)} m but the capture radius is ${f1(o.captureRadius)} m. Measured by the Dimension from true positions.`;
  return { success: o.success, title, rows, note };
}

/** The short human text of the last real replan decision, or null. */
export function routeChangeNote(s: Pick<CommandSnapshot, 'routeDecision' | 'route'>): { text: string; tone: 'changed' | 'stable' } | null {
  const d = s.routeDecision;
  if (!d || (s.route.state !== 'accepted' && s.route.state !== 'sent')) return null;
  if (d.kind === 'retained') return { text: 'Forecast stable — current route retained', tone: 'stable' };
  const why: Record<string, string> = { 'meeting-shifted': 'target motion revised', 'speed-changed': 'Baymax speed changed', 'off-route': 'Baymax left the planned line', 'stale-route': 'refreshed with new observations', 'mode-changed': 'forecast model changed', 'new-target': 'new destination', unsupported: 'forecast no longer supported' };
  return { text: `Route updated — ${why[d.trigger] ?? 'new observations'}`, tone: 'changed' };
}
