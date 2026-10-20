import type { CameraShot } from '../scene/sceneModel';
import type { Film, SegmentId } from './film';
import { clockToSim, segment, segmentAt } from './film';
import type { PlanDecision } from './atlasAgent';
import type { ProofSummary, PublicRun } from './publicRun';
import type { Vec3 } from './types';

/** The presentation director for the Moving Corridor film.
 *
 * SCIENTIFIC EVENT -> BEAT -> CAMERA + LAYERS + WORDS.
 * A beat is a pure function of the film clock and of the recorded run. It decides what to show, how the camera frames it and what the one headline and one
 * sentence say. It creates no observation and alters no number: every figure printed is read from the run (or, after the flight, from the labelled
 * offline evaluation). Only the framing and the wording are authored. */

export type Mode = 'immersive' | 'analysis' | 'decision';
export interface Layers {
  readonly samples: boolean;
  readonly fit: boolean;
  readonly forecast: boolean;
  readonly check: boolean;
  readonly bound: boolean;
  readonly direct: 'off' | 'map' | 'rejected';
  readonly critical: boolean;
  readonly candidates: number;
  readonly chosen: boolean;
  readonly replaced: boolean;
  readonly waypoints: boolean;
  readonly proof: boolean;
}
export interface FilmBeat {
  readonly segment: SegmentId;
  readonly u: number;
  readonly p: number;
  readonly kicker: string | null;
  readonly headline: string | null;
  readonly line: string | null;
  readonly chips: readonly string[];
  readonly mode: Mode;
  /** How much the world is subdued behind the mathematics (0 immersive .. 1). */
  readonly shade: number;
  readonly layers: Layers;
  readonly shot: CameraShot;
  /** Which world labels may be shown. */
  readonly labels: readonly string[];
}

const OFF: Layers = { samples: false, fit: false, forecast: false, check: false, bound: false, direct: 'off', critical: false, candidates: 0, chosen: false, replaced: false, waypoints: false, proof: false };
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const angle = (a: number, b: number, t: number) => { const d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * t; };
const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);

export interface WorldState { readonly sim: number; readonly baymax: Vec3; readonly heading: Vec3; readonly positions: ReadonlyMap<string, Vec3> }

/** What had been delivered at simulation time `sim`, interpolated linearly between 4 Hz deliveries (presentation smoothing only). */
export function worldAt(run: PublicRun, sim: number): WorldState {
  const k = Math.min(run.ticks.length - 1, Math.max(0, Math.floor(sim * 4 + 1e-9)));
  const a = run.ticks[k]!, b = run.ticks[Math.min(run.ticks.length - 1, k + 1)]!;
  const f = k === run.ticks.length - 1 ? 0 : Math.min(1, Math.max(0, sim * 4 - k));
  const mix = (p: Vec3, q: Vec3): Vec3 => [lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(p[2], q[2], f)];
  const positions = new Map<string, Vec3>();
  for (const s of a.sensed) { const n = b.sensed.find(x => x.id === s.id); positions.set(s.id, n && f > 0 ? mix(s.position, n.position) : s.position); }
  return { sim, baymax: mix(a.baymax, b.baymax), heading: a.heading, positions };
}

/** Frames `points`, then slides the subject toward the right and up so the caption block on the left stays clear. */
function frame(points: readonly Vec3[], yaw: number, pitch: number, pad = 10, minDist = 28, scale = 1.9, drift = 0.6, shift = 0.11, lift = 0.07): CameraShot {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
  const radius = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2;
  const dist = Math.max(minDist, (radius + pad) * scale);
  const centre: Vec3 = [(lo[0]! + hi[0]!) / 2 - Math.cos(yaw) * shift * dist, (lo[1]! + hi[1]!) / 2 - lift * dist, (lo[2]! + hi[2]!) / 2 + Math.sin(yaw) * shift * dist];
  return { centre, dist, yaw, pitch, drift };
}
export const blendShot = (a: CameraShot, b: CameraShot, t: number): CameraShot => ({
  centre: [lerp(a.centre[0], b.centre[0], t), lerp(a.centre[1], b.centre[1], t), lerp(a.centre[2], b.centre[2], t)],
  dist: lerp(a.dist, b.dist, t), yaw: angle(a.yaw, b.yaw, t), pitch: lerp(a.pitch, b.pitch, t), drift: lerp(a.drift, b.drift, t),
});

/** Everything the director reads about the run, gathered once. */
export interface DirectorContext {
  readonly run: PublicRun;
  readonly film: Film;
  readonly proof: ProofSummary | null;
  readonly goal: Vec3;
  readonly start: Vec3;
  readonly primary: string;
  readonly secondary: string | null;
  readonly first: PlanDecision;
}
export function contextOf(run: PublicRun, film: Film, proof: ProofSummary | null): DirectorContext {
  return { run, film, proof, goal: run.spec.goal, start: run.spec.start, primary: film.facts.primaryId, secondary: film.facts.secondaryId, first: run.decisions[0]! };
}

const posAt = (c: DirectorContext, id: string, sim: number): Vec3 => {
  const w = worldAt(c.run, sim).positions.get(id);
  if (w) return w;
  // Not currently sensed: its last sensed position at or before `sim`.
  for (let k = Math.min(c.run.ticks.length - 1, Math.floor(sim * 4)); k >= 0; k -= 1) { const s = c.run.ticks[k]!.sensed.find(x => x.id === id); if (s) return s.position; }
  for (const t of c.run.ticks) { const s = t.sensed.find(x => x.id === id); if (s) return s.position; }
  return c.goal;
};
const routePoints = (d: PlanDecision | undefined | null): Vec3[] => d?.chosen?.waypoints.map(w => w.position) ?? [];
const decisionAtOrBefore = (c: DirectorContext, sim: number): PlanDecision | null => { let out: PlanDecision | null = null; for (const d of c.run.decisions) if (d.time <= sim + 1e-9) out = d; return out; };

/** Shots per segment as [start, end]; the camera moves between them over the segment. */
function shots(c: DirectorContext, id: SegmentId, s: { simFrom: number | null; simTo: number | null }): readonly [CameraShot, CameraShot] {
  const F = c.film.facts, S = c.start, G = c.goal;
  const A = (t: number) => posAt(c, c.primary, t);
  const B = (t: number) => (c.secondary ? posAt(c, c.secondary, t) : G);
  const tD = F.tDecision;
  const w = worldAt(c.run, s.simTo ?? 0);
  const crit = c.first.directModelled.legs[0]?.clearance.worst ?? null;
  const route0 = routePoints(c.first);
  const proofIssue = F.proof?.issuedAt ?? 8, proofTarget = F.proof?.targetTime ?? 10;
  switch (id) {
    case 'intro': return [{ centre: [S[0] - 1.6, S[1] + 0.2, S[2]], dist: 17, yaw: 0.55, pitch: 0.1, drift: 1 }, { centre: [S[0] - 1.6, S[1] + 0.2, S[2]], dist: 13.5, yaw: 0.4, pitch: 0.12, drift: 1 }];
    case 'reveal': return [frame([S, G, A(0)], 1.0, 0.42, 6, 60, 1.7, 1), frame([S, G, A(0)], 0.85, 0.46, 6, 60, 1.7, 1)];
    case 'observe': return [frame([A(0), A(s.simTo ?? 8)], 0.4, 0.22, 10, 34, 1.9, 1, 0.14), frame([A(0), A(s.simTo ?? 8)], 0.2, 0.2, 10, 32, 1.9, 1, 0.14)];
    case 'model': return [frame([A(proofIssue - 5), A(proofIssue), A(proofTarget)], 0.15, 0.18, 6, 34, 1.9, 0.4, -0.2, 0.06), frame([A(proofIssue - 5), A(proofIssue), A(proofTarget)], -0.05, 0.2, 6, 32, 1.9, 0.4, -0.2, 0.06)];
    case 'verify': return [frame([A(proofIssue - 3), A(proofIssue), A(proofTarget)], -0.05, 0.2, 6, 32, 1.9, 0.3, -0.2, 0.06), frame([A(proofIssue - 1), A(proofTarget)], -0.05, 0.2, 6, 30, 1.9, 0.3, -0.2, 0.06)];
    case 'problem': return [frame([S, G, A(tD)], 0.25, 1.12, 4, 56, 1.55, 0.3, 0.1, 0.02), frame([S, G, A(tD)], 0.3, 1.08, 4, 54, 1.5, 0.3, 0.1, 0.02)];
    case 'conflict': return crit
      ? [frame([S, G, A(tD), crit.obstacleAtMin, crit.baymaxAtMin], 0.28, 1.08, 6, 62, 1.6, 0.3, -0.26, 0.02), frame([crit.obstacleAtMin, crit.baymaxAtMin, A(tD)], 0.35, 0.95, 20, 54, 1.8, 0.3, -0.28, 0.02)]
      : [frame([S, G, A(tD)], 0.3, 1.1), frame([S, G, A(tD)], 0.3, 1.0)];
    case 'calculate': return [frame([S, G, ...route0, A(tD)], 0.3, 1.0, 5, 58, 1.6, 0.3, -0.26, 0.02), frame([S, G, ...route0, A(tD)], 0.5, 0.9, 5, 58, 1.6, 0.3, -0.26, 0.02)];
    case 'fly': return [frame([w.baymax, ...route0.slice(1), A(tD)], 0.8, 0.5, 6, 46, 1.6, 0.8), frame([worldAt(c.run, s.simTo ?? tD).baymax, G, A(s.simTo ?? tD), ...(c.secondary ? [B(s.simTo ?? tD)] : [])], 0.9, 0.5, 6, 50, 1.6, 0.8)];
    case 'adapt': {
      const d = decisionAtOrBefore(c, s.simTo ?? 0);
      const pts = [worldAt(c.run, s.simFrom ?? 0).baymax, ...routePoints(d), A(s.simTo ?? 0), B(s.simTo ?? 0)];
      return [frame(pts, 0.7, 0.62, 6, 46, 1.6, 0.8), frame(pts, 1.1, 0.5, 6, 46, 1.6, 0.8)];
    }
    case 'arrive': return [frame([worldAt(c.run, s.simFrom ?? 0).baymax, G, B(s.simTo ?? 0)], 1.0, 0.4, 8, 56, 1.8, 0.8), frame([G, B(s.simTo ?? 0), worldAt(c.run, s.simTo ?? 0).baymax], 0.6, 0.3, 9, 44, 1.9, 1)];
    case 'proof': return [frame([S, G, A(0), A(c.film.facts.tArrive)], 0.3, 1.0, 6, 58, 1.5, 0.3, 0.1, 0.02), frame([S, G, A(0), A(c.film.facts.tArrive)], 0.45, 0.9, 6, 58, 1.5, 0.3, 0.1, 0.02)];
    case 'close': return [{ centre: [G[0] - 2, G[1] + 0.5, G[2]], dist: 22, yaw: 0.7, pitch: 0.2, drift: 1 }, { centre: [G[0] - 2, G[1] + 0.5, G[2]], dist: 28, yaw: 0.4, pitch: 0.18, drift: 1 }];
  }
}

const MODE: Record<SegmentId, Mode> = { intro: 'immersive', reveal: 'immersive', observe: 'immersive', model: 'analysis', verify: 'analysis', problem: 'decision', conflict: 'decision', calculate: 'decision', fly: 'immersive', adapt: 'decision', arrive: 'immersive', proof: 'analysis', close: 'immersive' };
const SHADE: Record<Mode, number> = { immersive: 0, analysis: 0.28, decision: 0.44 };

/** Direct the film at presentation time `clock`. */
export function direct(clock: number, c: DirectorContext): FilmBeat {
  const film = c.film, seg = segmentAt(film, clock);
  const id = seg.id as SegmentId;
  const idx = film.segments.indexOf(seg);
  const u = Math.max(0, clock - seg.from), p = Math.min(1, u / (seg.to - seg.from));
  const sim = clockToSim(film, clock);
  const tick = sim === null ? -1 : Math.floor(sim * 4 + 1e-9);
  const rec = tick >= 0 ? c.run.ticks[Math.min(tick, c.run.ticks.length - 1)]! : null;
  const F = film.facts, d0 = c.first;

  // Camera: eased path between the segment's two shots, entered from the previous segment's last shot.
  const [a, b] = shots(c, id, seg);
  let shot = blendShot(a, b, smooth(p));
  if (idx > 0) {
    const prev = film.segments[idx - 1]!;
    const [, prevEnd] = shots(c, prev.id as SegmentId, prev);
    const enter = smooth(u / 1.8);
    if (enter < 1) shot = blendShot(prevEnd, shot, enter);
  }

  // Mode (and the shade behind the mathematics) cross-fades over the first second of a segment.
  const mode = MODE[id];
  const prevMode = idx > 0 ? MODE[film.segments[idx - 1]!.id as SegmentId] : mode;
  const shade = lerp(SHADE[prevMode], SHADE[mode], smooth(u / 1.2));

  const observationsOf = (obs: string) => (tick < 0 ? 0 : c.run.ticks.slice(0, tick + 1).filter(t => t.sensed.some(s => s.id === obs)).length);
  const proofFc = F.proof;
  const model = rec?.step.obstacles.find(o => o.id === c.primary)?.fit ?? null;
  const at = (sec: number) => (sim ?? 0) >= sec - 1e-9;
  const L = (o: Partial<Layers>): Layers => ({ ...OFF, ...o });
  const out = (kicker: string | null, headline: string | null, line: string | null, chips: string[], layers: Layers, labels: string[] = []): FilmBeat =>
    ({ segment: id, u, p, kicker, headline, line, chips, mode, shade, layers, shot, labels });

  switch (id) {
    case 'intro':
      return out('BIG HERO 6 · FRACTURED', 'ATLAS', 'A mathematical intelligence for an unstable dimension.', [], L({}), []);
    case 'reveal':
      return out('THE PROBLEM', 'Baymax can see the capsule.', 'The way between them looks clear.', [], L({ direct: u > 3.5 ? 'map' : 'off' }), ['baymax', 'capsule']);
    case 'observe':
      return out('OBSERVE', 'The island is moving.', 'ATLAS records where it is, again and again.', [`${observationsOf(c.primary)} observations · 4 per second`], L({ samples: true, bound: p > 0.35 }), ['island-a']);
    case 'model': {
      const v = model?.validation;
      return out('MODEL', 'ATLAS fits a motion model.', 'From its history alone, it estimates where the island will be.', model && v ? [`${model.support.count} samples · ${f1(model.support.span)} s`, `${v.selected} model · beats “stays put” ${f2(v.rmse.persistence / Math.min(v.rmse.linear ?? 99, v.rmse.quadratic ?? 99))}× in validation`] : [], L({ samples: true, fit: true, forecast: p > 0.4, bound: true }), ['island-a', 'forecast']);
    }
    case 'verify': {
      const done = proofFc !== null && at(proofFc.targetTime);
      return out('VERIFY', 'Then it checks itself.', 'A frozen estimate meets the later measurement.', proofFc && done ? [`error ${f2(proofFc.modelError ?? 0)} u`, `“stays put” would have missed by ${f2(proofFc.baselineError ?? 0)} u`] : ['estimate frozen — measurement pending'], L({ samples: true, fit: true, forecast: true, check: done, bound: true }), ['island-a']);
    }
    case 'problem':
      return out('PLAN', 'The map says the way is clear.', 'A static plan treats the island as fixed.', [`direct route · clearance +${f1(d0.directStatic.minMargin)} u beyond the minimum`], L({ direct: 'map', bound: true }), ['capsule', 'island-a']);
    case 'conflict': {
      const w = d0.directModelled.legs[0]?.clearance.worst;
      return out('PLAN', 'The corridor is closing.', w ? `The island is moving into the path. At t = ${f1(w.timeAtMin)} s ATLAS predicts ${f1(w.clearanceAtMin)} u of clearance; it needs ${f1(w.requiredAtMin)} u.` : '', ['direct route rejected'], L({ direct: u > 1.5 ? 'rejected' : 'map', critical: u > 3, bound: true, forecast: false }), ['critical', 'island-a']);
    }
    case 'calculate': {
      const ch = d0.chosen;
      return out('PLAN', 'ATLAS calculates another route.', `${d0.legsEvaluated.toLocaleString('en-US')} flight legs checked against the predicted motion.`, ch ? [`${f1(ch.length)} u vs ${f1(d0.directModelled.length)} u direct`, `margin ${ch.minMargin >= 0 ? '+' : ''}${f1(ch.minMargin)} u beyond the minimum`] : [], L({ direct: 'rejected', candidates: smooth(p * 3), chosen: p > 0.45, waypoints: p > 0.6, bound: true }), ['route']);
    }
    case 'fly': {
      const seen = F.tSecondSeen !== null && at(F.tSecondSeen);
      return out('ADAPT', 'Baymax follows it.', seen ? 'A second island has come into range.' : 'Measurements keep arriving.', [`route ${rec?.step.routeId ?? 1}`], L({ chosen: true, waypoints: true, samples: true, bound: seen, check: !!c.film.facts.planning && at(c.film.facts.planning.targetTime) }), seen ? ['island-b'] : []);
    }
    case 'adapt': {
      const r = F.replans.filter(x => at(x.time));
      const last = r.at(-1);
      const cause = last?.obstacleId === c.secondary ? 'Island B' : 'Island A';
      return out('ADAPT', 'New evidence. New route.', last ? `${cause}’s motion put the old route ${f1(Math.abs(last.margin))} u short. ATLAS recomputed it.` : 'ATLAS keeps checking the route against its newest estimates.', [`route ${rec?.step.routeId ?? 1}`, `${r.length} update${r.length === 1 ? '' : 's'} so far`], L({ chosen: true, waypoints: true, replaced: true, bound: true, samples: true }), ['island-a', 'island-b']);
    }
    case 'arrive':
      return out('RESULT', 'Baymax reaches the capsule.', null, [], L({ chosen: p < 0.7, samples: false }), ['capsule']);
    case 'proof': {
      const pr = c.proof;
      return out('VERIFY', 'Checked against the truth.', 'Offline, against ground truth ATLAS never saw.', pr ? [`ATLAS path: closest approach ${f1(pr.atlas.minDistance)} u`, `direct route would have passed ${f1(pr.direct.minDistance)} u from the island (needed ${f1(pr.direct.required)} u)`] : [], L({ proof: true, chosen: true, direct: 'rejected', bound: true }), ['proof']);
    }
    case 'close':
      return out('REPRODUCE', 'Every number here is computed.', 'npm run atlas:challenge:verify', ['CONTROLLED MATHEMATICAL CHALLENGE · simulated scenario'], L({}), []);
  }
}

export { segment };
