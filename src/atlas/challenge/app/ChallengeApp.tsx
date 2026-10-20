import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { contextOf, direct } from '../director';
import type { DirectorContext } from '../director';
import { evaluateShowcase, executedPosition, truthSeries } from '../evaluate';
import { buildFilm, factsFromRun } from '../film';
import type { Film } from '../film';
import { presentAt } from '../presentation';
import type { ProofSummary } from '../publicRun';
import { runChallenge } from '../run';
import { SHOWCASE_SPEC } from '../showcase';
import { ChallengeStage } from '../scene/ChallengeStage';
import type { StageLabel } from '../scene/ChallengeStage';
import { ChallengeUI } from '../ui/ChallengeUI';
import type { CaptionCue } from '../ui/ChallengeUI';
import { evidenceAt } from '../ui/evidence';
import '../ui/challenge.css';

interface Built { readonly ctx: DirectorContext; readonly film: Film }

function build(): Built {
  const run = runChallenge(SHOWCASE_SPEC);
  const ev = evaluateShowcase(run)!;
  const proof: ProofSummary = {
    atlas: { minDistance: ev.atlas.truth.minDistance, required: ev.atlas.truth.required, margin: ev.atlas.truth.minMargin, atTime: ev.atlas.truth.atTime, obstacle: ev.atlas.truth.obstacleId, baymaxAt: ev.atlas.truth.baymaxAt, obstacleAt: ev.atlas.truth.obstacleAt },
    direct: { minDistance: ev.direct.truth.minDistance, required: ev.direct.truth.required, margin: ev.direct.truth.minMargin, atTime: ev.direct.truth.atTime, obstacle: ev.direct.truth.obstacleId, length: ev.direct.length, baymaxAt: ev.direct.truth.baymaxAt, obstacleAt: ev.direct.truth.obstacleAt },
    atlasLength: ev.atlas.length, arrival: ev.atlas.arrival, proofForecast: null, chart: undefined as never,
  };
  const dep = ev.departure, endT = ev.atlas.arrival ?? run.spec.durationSeconds;
  const first = run.decisions[0]!, speed = run.spec.params.speed;
  const dlen = ev.direct.length, dir = first.goal.map((g, i) => (g - first.start[i]!) / dlen);
  const atlasSeries = truthSeries(run, t => executedPosition(run, t), dep, endT);
  const directSeries = truthSeries(run, t => { const s = Math.min(dlen, (t - dep) * speed); return [first.start[0] + dir[0]! * s, first.start[1] + dir[1]! * s, first.start[2] + dir[2]! * s]; }, dep, dep + dlen / speed);
  const req = ev.atlas.truth.required;
  const minOf = (xs: { t: number; v: number }[]) => xs.reduce((m, x) => (x.v < m.v ? x : m));
  const dm = minOf(directSeries), am = minOf(atlasSeries);
  (proof as { chart: unknown }).chart = { t0: dep, t1: endT, direct: directSeries, chosen: atlasSeries, required: [{ t: dep, v: req }, { t: endT, v: req }], horizonEnd: endT + 1, conflict: { t: dm.t, distance: dm.v, required: req }, chosenMin: { t: am.t, distance: am.v, required: req }, obstacle: 'the nearest island', decisionTime: dep, title: 'GROUND TRUTH', subtitle: 'Actual distance to the nearest island · u · seconds · evaluated offline', firstLabel: 'direct route (not flown)', secondLabel: 'path ATLAS flew', requiredLabel: 'minimum' };
  // The presentation holds the recorded run WITHOUT the simulated world.
  const { world: _world, ...publicRun } = run;
  void _world;
  const film = buildFilm(factsFromRun(publicRun, SHOWCASE_SPEC.obstacles[0]!.id));
  return { ctx: contextOf(publicRun, film, proof), film };
}

const mid = (a: readonly number[], b: readonly number[]): [number, number, number] => [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2 + 1.5, (a[2]! + b[2]!) / 2];
const f1 = (n: number) => n.toFixed(1);

declare global { interface Window { __film?: { duration: number; ready: () => boolean; setClock: (t: number) => void; step: (ms: number) => void; segments: () => readonly { id: string; from: number; to: number }[] } } }

export function ChallengeApp() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const filmMode = q.get('film') === '1';
  const [built, setBuilt] = useState<Built | null>(null);
  const [clock, setClock] = useState(() => Math.max(0, Number(q.get('t') ?? 0) || 0));
  const [playing, setPlaying] = useState(q.get('autoplay') === '1');
  const [speed, setSpeed] = useState(1);
  const [manual, setManual] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(q.get('evidence') === '1');
  const [begun, setBegun] = useState(filmMode || q.get('begin') === '1' || q.has('t'));
  const [glbReady, setGlbReady] = useState(false);
  const [cues, setCues] = useState<readonly CaptionCue[]>([]);
  const clockRef = useRef(clock); clockRef.current = clock;
  const stepApi = useRef<{ step: (ms: number) => void } | null>(null);
  const labelLayer = useRef<HTMLDivElement | null>(null);

  useEffect(() => { const id = window.setTimeout(() => setBuilt(build()), 30); return () => window.clearTimeout(id); }, []);
  useEffect(() => {
    if (q.get('captions') !== '1') return;
    void fetch(`${import.meta.env.BASE_URL}captions.json`).then(r => r.json()).then((c: CaptionCue[]) => setCues(c)).catch(() => setCues([]));
  }, [q]);

  // Interactive clock.
  useEffect(() => {
    if (!playing || !built || filmMode) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
      const next = Math.min(built.film.duration, clockRef.current + dt * speed);
      setClock(next);
      if (next >= built.film.duration) setPlaying(false);
    }, 33);
    return () => window.clearInterval(id);
  }, [playing, built, speed, filmMode]);

  const view = useMemo(() => {
    if (!built) return null;
    let beat = direct(clock, built.ctx);
    // Camera exploration (authoring aid): ?shot=yaw,pitch,dist[,cx,cy,cz] overrides the directed shot; without a centre, the directed centre is kept.
    const override = q.get('shot')?.split(',').map(Number);
    if (override && override.length >= 3 && override.every(Number.isFinite)) beat = { ...beat, shot: { ...beat.shot, yaw: override[0]!, pitch: override[1]!, dist: override[2]!, centre: override.length >= 6 ? [override[3]!, override[4]!, override[5]!] : beat.shot.centre, drift: 0 } };
    const presentation = presentAt(clock, beat, built.ctx);
    const evidence = evidenceOpen ? evidenceAt(clock, beat, built.ctx) : [];
    const o = presentation.overlay, B = built.ctx;
    const labels: StageLabel[] = [];
    const want = (k: string) => beat.labels.includes(k);
    if (want('baymax') && o.baymax) labels.push({ key: 'baymax', text: 'BAYMAX', position: [o.baymax[0], o.baymax[1] + 3.2, o.baymax[2]], tone: 'neutral' });
    if (want('capsule')) labels.push({ key: 'capsule', text: 'DAMAGED CAPSULE', sub: o.baymax ? `${f1(Math.hypot(o.goal[0] - o.baymax[0], o.goal[1] - o.baymax[1], o.goal[2] - o.baymax[2]))} u away` : undefined, position: [o.goal[0], o.goal[1] + 5, o.goal[2]], tone: 'lilac' });
    for (const [key, id, text] of [['island-a', B.primary, 'ISLAND A'], ['island-b', B.secondary, 'ISLAND B']] as const) {
      const t = id ? o.trails.find(x => x.id === id) : undefined;
      if (want(key) && t?.current) {
        const fit = presentation.scene.islands.length ? undefined : undefined; void fit;
        labels.push({ key, text, position: [t.current[0], t.current[1] + 7.5, t.current[2]], tone: 'neutral' });
      }
    }
    const g = o.ghosts.find(x => x.kind === 'forecast');
    if (want('forecast') && g) labels.push({ key: 'forecast', text: 'ATLAS ESTIMATE', sub: g.label?.replace('ATLAS estimate for ', 'for ') ?? undefined, position: [g.position[0], g.position[1] + g.radius + 7, g.position[2]], tone: 'lilac' });
    if (want('forecast') && o.persistence) labels.push({ key: 'stays', text: 'IF IT STAYED PUT', position: [o.persistence.position[0], o.persistence.position[1] - 2.2, o.persistence.position[2]], tone: 'neutral' });
    if (want('measured') && o.measured) labels.push({ key: 'measured', text: 'MEASURED', sub: `${o.measured.error.toFixed(2)} u from the estimate`, position: [o.measured.position[0], o.measured.position[1] + 2.4, o.measured.position[2]], tone: 'warm' });
    if (want('critical') && o.critical) labels.push({ key: 'critical', text: 'PREDICTED GAP', sub: `${f1(o.critical.clearance)} u · needs ${f1(o.critical.required)} u`, position: mid(o.critical.obstacle, o.critical.baymax), tone: 'amber' });
    if (want('route') && o.chosen) { const m = o.chosen[Math.floor(o.chosen.length / 2)]!; labels.push({ key: 'route', text: 'ATLAS ROUTE', sub: B.first.chosen ? `${f1(B.first.chosen.length)} u` : undefined, position: [m[0], m[1] + 3, m[2]], tone: 'lilac' }); }
    if (want('proof') && o.proof && B.proof) {
      labels.push({ key: 'proof-a', text: 'ATLAS PATH', sub: `closest ${f1(B.proof.atlas.minDistance)} u`, position: mid(o.proof.atlasClosest.baymax, o.proof.atlasClosest.obstacle), tone: 'lilac' });
      labels.push({ key: 'proof-d', text: 'DIRECT ROUTE', sub: `closest ${f1(B.proof.direct.minDistance)} u`, position: mid(o.proof.directClosest.baymax, o.proof.directClosest.obstacle), tone: 'amber' });
    }
    return { beat, presentation, evidence, labels };
  }, [built, clock, evidenceOpen, q]);

  const onReady = useCallback(() => setGlbReady(true), []);
  const onStepApi = useCallback((api: { step: (ms: number) => void }) => { stepApi.current = api; }, []);

  useEffect(() => {
    if (!built) return;
    window.__film = {
      duration: built.film.duration, ready: () => glbReady && stepApi.current !== null && !!labelLayer,
      setClock: (t: number) => { flushSync(() => setClock(Math.min(built.film.duration, Math.max(0, t)))); },
      step: (ms: number) => stepApi.current?.step(ms),
      segments: () => built.film.segments.map(s => ({ id: s.id, from: s.from, to: s.to })),
    };
    return () => { delete window.__film; };
  }, [built, glbReady]);

  if (!built || !view) return <div className="ch-root"><div className="ch-loading">COMPUTING THE CHALLENGE…</div></div>;
  const primary = built.ctx.primary;
  const assetBase = import.meta.env.BASE_URL;
  const interactive = !filmMode;
  return (
    <div className="ch-root" data-film={filmMode ? '1' : '0'} data-testid="challenge-root" data-segment={view.beat.segment} data-clock={clock.toFixed(2)} data-ready={glbReady ? '1' : '0'}>
      <ChallengeStage presentation={view.presentation} beat={view.beat} labels={view.labels} film={filmMode} assetBase={assetBase} primaryId={primary} manual={manual && interactive} onManual={() => setManual(true)} onReady={onReady} onStepApi={onStepApi} labelLayer={labelLayer} />
      <ChallengeUI beat={view.beat} film={built.film} clock={clock} playing={playing} interactive={interactive && begun} evidence={view.evidence} modelChart={view.presentation.modelChart} clearanceChart={view.presentation.clearanceChart} evidenceOpen={evidenceOpen} manual={manual} labels={view.labels} labelLayer={labelLayer}
        cues={cues} showCaptions={q.get('captions') === '1'} speed={speed} onPlay={() => setPlaying(v => !v)} onRestart={() => { setClock(0); setPlaying(true); }} onSeek={t => { setClock(t); }} onSpeed={setSpeed}
        onEvidence={() => setEvidenceOpen(v => !v)} onResume={() => setManual(false)} />
      {!begun && !filmMode && (
        <div className="ch-begin" data-testid="challenge-begin">
          <h1>THE MOVING CORRIDOR</h1>
          <p>Baymax must reach a damaged capsule across a region where an island is drifting into the straight path. ATLAS observes, models the motion, and calculates a route. About two and a half minutes.</p>
          <p style={{ fontSize: '0.9em', color: '#ffd9a6' }}>CONTROLLED MATHEMATICAL CHALLENGE · simulated scenario with real Dimension island motion</p>
          <div><button data-testid="begin-challenge" onClick={() => { setBegun(true); setPlaying(true); }}>BEGIN</button></div>
        </div>
      )}
    </div>
  );
}
