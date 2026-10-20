import type { DirectorContext, FilmBeat } from '../director';
import { clockToSim } from '../film';
import { predictMotion } from '../motionModel';
import { staticClearance } from '../types';

/** The inspectable numbers behind the film, read from the recorded run at the current film clock. */
export interface EvidenceSection { readonly title: string; readonly rows: readonly (readonly [label: string, value: string])[] }

const f = (n: number, d = 2) => n.toFixed(d);
const v3 = (v: readonly number[]) => `(${v.map(x => x.toFixed(2)).join(', ')})`;

export function evidenceAt(clock: number, beat: FilmBeat, c: DirectorContext): EvidenceSection[] {
  void beat;
  const sim = clockToSim(c.film, clock);
  const tick = sim === null ? -1 : Math.min(c.run.ticks.length - 1, Math.floor(sim * 4 + 1e-9));
  const rec = tick >= 0 ? c.run.ticks[tick]! : null;
  const out: EvidenceSection[] = [];
  const p = c.run.spec.params;
  const samples = rec ? c.run.ticks.slice(0, tick + 1).filter(t => t.sensed.some(s => s.id === c.primary)) : [];
  out.push({ title: 'Observations', rows: [
    ['Entity', `${c.primary} (island A)`], ['Samples received', String(samples.length)], ['First / latest', samples.length ? `${f(samples[0]!.time)} s / ${f(samples.at(-1)!.time)} s` : '—'],
    ['Sensor', `${c.run.spec.sensorRange} u range · ${c.run.spec.tickHz} Hz · noise σ ${c.run.spec.noiseSigma} u`],
  ] });
  const fit = rec?.step.obstacles.find(o => o.id === c.primary)?.fit ?? null;
  if (fit && fit.validation) {
    const vel = predictMotion(fit, fit.issuedAt).velocity;
    out.push({ title: 'Model', rows: [
      ['Selected', `${fit.kind}, trained on ${fit.support.count} samples (${f(fit.support.span, 1)} s)`], ['Velocity at issue', `${v3(vel)} u/s · ${f(fit.speed, 3)} u/s`], ['Residual σ', `${f(fit.sigma, 3)} u`],
      ['Validation (3 s ahead)', fit.validation.candidates.map(x => `${x.name} ${f(x.rmse, 3)}`).join(' · ')], ['Trust horizon', `${f(fit.horizon, 1)} s`],
    ] });
  }
  const pr = c.film.facts.proof;
  if (pr) {
    out.push({ title: 'Prediction (frozen)', rows: [
      ['Issued → target', `${f(pr.issuedAt, 1)} s → ${f(pr.targetTime, 1)} s (${pr.lead} s ahead)`], ['ATLAS estimate', v3(pr.estimate)], ['“Stays put”', v3(pr.baseline)], ['Stated allowance', `± ${f(pr.allowance)} u`],
    ] });
    if (pr.observed && sim !== null && sim >= pr.targetTime - 1e-9) out.push({ title: 'Evaluation', rows: [
      ['Later measurement', v3(pr.observed)], ['ATLAS error', `${f(pr.modelError ?? 0, 3)} u`], ['“Stays put” error', `${f(pr.baselineError ?? 0, 3)} u`], ['Within stated allowance', (pr.modelError ?? 0) <= pr.allowance ? 'yes' : 'no'],
    ] });
  }
  const d = rec?.step.decisionId ? c.run.decisions[rec.step.decisionId - 1] : (sim !== null && sim >= c.film.facts.tDecision ? c.first : null);
  if (d) {
    out.push({ title: 'Constraint', rows: [
      ['Required centre distance', `Baymax ${p.baymaxRadius} + obstacle bound ${p.obstacleBound} + margin ${p.margin} = ${f(staticClearance(p), 1)} u, plus the model’s uncertainty`],
      ['Direct route, static plan', `${d.directStatic.feasible ? 'clear' : 'blocked'} (margin ${f(d.directStatic.minMargin)} u)`],
      ['Direct route, ATLAS', `${d.directModelled.feasible ? 'clear' : 'rejected'} (margin ${f(d.directModelled.minMargin)} u vs ${d.directModelled.worstObstacleId ?? '—'})`],
    ] });
    out.push({ title: 'Planning', rows: [
      ['Candidate waypoints', String(d.candidateWaypoints)], ['Flight legs evaluated / rejected', `${d.legsEvaluated} / ${d.legsRejected}`], ['Planning time', `${f(d.computeMs, 0)} ms`],
      ['Chosen route', d.chosen ? `${d.chosen.waypoints.length - 1} legs · ${f(d.chosen.length, 1)} u · min margin ${f(d.chosen.minMargin)} u` : 'none'],
    ] });
  }
  if (c.film.facts.replans.length && sim !== null) {
    const done = c.film.facts.replans.filter(r => sim >= r.time - 1e-9);
    if (done.length) out.push({ title: 'Route updates', rows: done.map((r, i) => [`Update ${i + 1} · t = ${f(r.time, 2)} s`, `${r.obstacleId ?? 'obstacle'} estimate left the old route ${f(Math.abs(r.margin))} u short`] as const) });
  }
  if (c.proof && sim !== null && sim >= c.film.facts.tArrive - 1e-9) out.push({ title: 'Ground truth (offline)', rows: [
    ['ATLAS path, closest approach', `${f(c.proof.atlas.minDistance)} u (needed ${f(c.proof.atlas.required, 1)} u)`], ['Direct route, closest approach', `${f(c.proof.direct.minDistance)} u (needed ${f(c.proof.direct.required, 1)} u)`],
  ] });
  return out;
}
