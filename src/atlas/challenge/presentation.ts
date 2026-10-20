import type { SceneIsland, SceneModel } from '../scene/sceneModel';
import type { ScanPulse } from '../live/knowledge';
import type { DirectorContext, FilmBeat } from './director';
import { worldAt } from './director';
import { clearanceChartAt, modelChartAt } from './chartData';
import type { ClearanceChart, ModelChart } from './chartData';
import { clockToSim, simToClock } from './film';
import { predictMotion } from './motionModel';
import { staticClearance } from './types';
import type { Vec3 } from './types';

/** From a film clock to everything the renderer and the interface need: the scene model for the established ATLAS world components,
 * and the geometry of the mathematical overlay. All of it is read from the recorded run; nothing is invented or looked ahead. */

export interface Ghost { readonly key: string; readonly position: Vec3; readonly radius: number; readonly alpha: number; readonly label: string | null; readonly kind: 'forecast' | 'critical' }
export interface OverlayData {
  readonly clock: number;
  readonly sim: number | null;
  readonly start: Vec3;
  readonly goal: Vec3;
  readonly baymax: Vec3 | null;
  readonly baymaxTrail: readonly Vec3[];
  readonly centres: readonly { readonly id: string; readonly position: Vec3 }[];
  readonly trails: readonly { readonly id: string; readonly points: readonly Vec3[]; readonly current: Vec3 | null }[];
  readonly fits: readonly { readonly id: string; readonly past: readonly Vec3[]; readonly future: readonly Vec3[] }[];
  readonly ghosts: readonly Ghost[];
  readonly persistence: { readonly position: Vec3 } | null;
  readonly measured: { readonly position: Vec3; readonly error: number } | null;
  readonly bounds: readonly { readonly id: string; readonly position: Vec3; readonly radius: number }[];
  readonly critical: { readonly obstacle: Vec3; readonly baymax: Vec3; readonly clearance: number; readonly required: number; readonly time: number; readonly shell: number } | null;
  readonly direct: { readonly from: Vec3; readonly to: Vec3; readonly mode: 'map' | 'rejected' } | null;
  readonly candidates: readonly (readonly Vec3[])[];
  readonly candidateReveal: number;
  readonly chosen: readonly Vec3[] | null;
  readonly replaced: { readonly points: readonly Vec3[]; readonly fade: number } | null;
  readonly waypoints: readonly Vec3[];
  readonly proof: { readonly atlasClosest: { readonly baymax: Vec3; readonly obstacle: Vec3 }; readonly directClosest: { readonly baymax: Vec3; readonly obstacle: Vec3 } } | null;
  readonly scanItems: readonly { readonly id: string; readonly kind: string; readonly position: Vec3; readonly radius: number; readonly revealAt: number }[];
}
export interface Presentation { readonly scene: SceneModel; readonly overlay: OverlayData; readonly sim: number | null; readonly tick: number; readonly modelChart: ModelChart | null; readonly clearanceChart: ClearanceChart | null }

const SAMPLE_STEP = 0.25;

export function presentAt(clock: number, beat: FilmBeat, c: DirectorContext): Presentation {
  const { run, film } = c;
  const sim = clockToSim(film, clock);
  const tick = sim === null ? -1 : Math.min(run.ticks.length - 1, Math.floor(sim * 4 + 1e-9));
  const rec = tick >= 0 ? run.ticks[tick]! : null;
  const world = sim === null ? null : worldAt(run, sim);
  const L = beat.layers;

  // Presentation time at which each entity was first recorded (drives the reveal sweep).
  const firstSensed = new Map<string, number>();
  for (const t of run.ticks) for (const s of t.sensed) if (!firstSensed.has(s.id)) firstSensed.set(s.id, t.time);

  const islands: SceneIsland[] = [];
  if (rec && world) for (const [id, position] of world.positions) {
    const first = firstSensed.get(id) ?? 0;
    islands.push({ id, position, observed: true, firstSeenAt: simToClock(film, first), lastSeenAt: clock, observationCount: run.ticks.slice(0, tick + 1).filter(t => t.sensed.some(s => s.id === id)).length });
  }
  const pulseTimes: number[] = [0];
  if (c.secondary && firstSensed.has(c.secondary)) pulseTimes.push(firstSensed.get(c.secondary)!);
  const pulses: ScanPulse[] = pulseTimes.filter(t => t <= (sim ?? -1) + 1e-9).map(t => ({ atS: simToClock(film, t), range: 26 })).sort((a, b) => a.atS - b.atS);

  const scene: SceneModel = {
    time: clock,
    observer: rec && world ? { position: world.baymax, firstSeenAt: simToClock(film, 0) } : null,
    islands, folds: [], objects: [], clusters: [], pulses, motionReference: 3.2, changes: [], estimates: [], stage: null, navigation: null,
    lens: 'memory', hero: c.start, shot: beat.shot, focus: beat.segment === 'model' || beat.segment === 'verify' ? { ids: [], debris: false } : null,
  };

  // Scanned wreckage: only what the scene-scan memory holds at this tick.
  const scanItems = (rec?.scene.records ?? []).map(r => ({ id: r.id, kind: r.kind, position: r.lastKnownPosition, radius: r.radius, revealAt: simToClock(film, r.firstSeenAt) }));

  // Trails of sensed positions and Baymax's flown path.
  const trails = [c.primary, ...(c.secondary ? [c.secondary] : [])].map(id => {
    const points: Vec3[] = [];
    for (let k = 0; k <= tick; k += 1) { const s = run.ticks[k]!.sensed.find(x => x.id === id); if (s) points.push(s.position); }
    return { id, points, current: world?.positions.get(id) ?? null };
  }).filter(t => t.points.length > 0);
  const baymaxTrail: Vec3[] = [];
  for (let k = 0; k <= tick; k += 2) baymaxTrail.push(run.ticks[k]!.baymax);

  // Fitted motion: the curve through the history, and its extension into the future.
  const fits: { id: string; past: Vec3[]; future: Vec3[] }[] = [];
  const ghosts: Ghost[] = [];
  let persistence: OverlayData['persistence'] = null;
  let measured: OverlayData['measured'] = null;
  if (rec && L.fit) {
    const o = rec.step.obstacles.find(x => x.id === c.primary);
    if (o?.fit) {
      const f = o.fit;
      const past: Vec3[] = [], future: Vec3[] = [];
      for (let t = f.support.start; t <= f.issuedAt + 1e-9; t += SAMPLE_STEP) past.push(predictMotion(f, t).position);
      const lead = c.film.facts.proof ? c.film.facts.proof.lead : 2;
      for (let t = f.issuedAt; t <= f.issuedAt + lead + 1e-9; t += SAMPLE_STEP / 2) future.push(predictMotion(f, t).position);
      fits.push({ id: o.id, past, future });
    }
  }
  const proof = c.film.facts.proof;
  if (proof && L.forecast) {
    ghosts.push({ key: 'forecast', position: proof.estimate, radius: Math.max(0.6, proof.allowance), alpha: 1, label: `ATLAS estimate for t = ${proof.targetTime.toFixed(0)} s`, kind: 'forecast' });
    persistence = { position: proof.baseline };
  }
  if (proof && L.check && proof.observed) measured = { position: proof.observed, error: proof.modelError ?? 0 };

  const bounds = L.bound ? islands.map(i => ({ id: i.id, position: i.position, radius: run.spec.params.obstacleBound })) : [];

  const d0 = c.first;
  const worst = d0.directModelled.legs[0]?.clearance.worst ?? null;
  const critical = L.critical && worst ? { obstacle: worst.obstacleAtMin, baymax: worst.baymaxAtMin, clearance: worst.clearanceAtMin, required: worst.requiredAtMin, time: worst.timeAtMin, shell: worst.requiredAtMin } : null;
  if (critical) ghosts.push({ key: 'critical', position: critical.obstacle, radius: run.spec.params.obstacleBound, alpha: 1, label: `predicted position at t = ${critical.time.toFixed(1)} s`, kind: 'critical' });

  const direct = L.direct === 'off' ? null : { from: d0.start, to: d0.goal, mode: L.direct };
  const candidates = L.candidates > 0 ? d0.alternatives.slice(0, 3).map(r => r.waypoints.map(w => w.position)) : [];
  const currentRoute = rec?.step.route ? rec.step.route.waypoints.map(w => w.position) : null;
  const chosen = L.chosen ? (currentRoute ?? (d0.chosen ? d0.chosen.waypoints.map(w => w.position) : null)) : null;

  // The route that was just replaced fades out for three seconds after its replacement.
  let replaced: OverlayData['replaced'] = null;
  if (L.replaced && sim !== null) {
    for (let i = run.decisions.length - 1; i >= 1; i -= 1) {
      const d = run.decisions[i]!;
      if (d.time <= sim + 1e-9 && sim - d.time < 3) { const prev = run.decisions[i - 1]!.chosen; if (prev) replaced = { points: prev.waypoints.map(w => w.position), fade: 1 - (sim - d.time) / 3 }; break; }
    }
  }
  const waypoints = L.waypoints && chosen ? chosen.slice(1, -1) : [];

  const pr = c.proof;
  const proofGeo = L.proof && pr ? { atlasClosest: { baymax: pr.atlas.baymaxAt as Vec3, obstacle: pr.atlas.obstacleAt as Vec3 }, directClosest: { baymax: pr.direct.baymaxAt as Vec3, obstacle: pr.direct.obstacleAt as Vec3 } } : null;

  const overlay: OverlayData = {
    clock, sim, start: c.start, goal: c.goal, baymax: world?.baymax ?? null, baymaxTrail, trails, centres: L.samples || L.fit ? islands.map(i => ({ id: i.id, position: i.position })) : [], fits, ghosts, persistence, measured, bounds, critical, direct,
    candidates, candidateReveal: L.candidates, chosen, replaced, waypoints, proof: proofGeo, scanItems: tick >= 0 ? scanItems : [],
  };
  void staticClearance;
  const modelChart = sim !== null && (beat.segment === 'model' || beat.segment === 'verify') ? modelChartAt(sim, c) : null;
  const clearanceChart = sim !== null && (beat.segment === 'conflict' || beat.segment === 'calculate' || beat.segment === 'adapt') ? clearanceChartAt(sim, c) : beat.segment === 'proof' && c.proof ? c.proof.chart : null;
  return { scene, overlay, sim, tick, modelChart, clearanceChart };
}
