// QA: closed-loop capture statistics over many start phases and Baymax speeds. Variant of tests/support/closedLoop.ts that additionally records
// the RouteManager's own outcome (missed/arrived, plannedError at the planned time) and per-run replans. Nothing tuned; misses are reported.
//   VARIANT=cruise|fast npx tsx scripts/qa-final-science.ts [out]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CommandSession } from '../src/atlas/command/session';
import { LINK_CHANNEL, LINK_VERSION } from '../src/atlas/live/protocol';
import type { Vec3 } from '../src/atlas/command/world';
import { RouteManager } from '../tests/support/dimensionNav';
import { MOVER_DEFS } from '../tests/support/dimensionMovers';
import { LiveWorld } from '../tests/support/liveWorld';

const ORIGIN = 'http://127.0.0.1:4173', CAPSULE = 'capsule-abigail', CAPTURE = MOVER_DEFS[0]!.radius + 4;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
interface Res { strategy: string; speed: number; warmup: number; offset: number; phase: string; success: boolean; seconds: number; closest: number; replans: number; plannedError: number | null; plannedTime: number | null; actualTime: number | null; path: number }

function run(strategy: 'atlas' | 'chase', variant: 'cruise' | 'fast', start: Vec3, speed: number, warmup: number, offset: number, limit = 90): Res | null {
  let wall = 0;
  const world = new LiveWorld('qa', variant);
  const session = new CommandSession({ dimensionUrl: ORIGIN, now: () => wall });
  const dim = new RouteManager();
  let seq = 0, replans = 0;
  const post = (type: string, body: Record<string, unknown>) => { seq += 1; session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type, session: 'qa', seq, ...body }); };
  const resolver = (id: string) => (id === CAPSULE ? { position: world.truth(CAPSULE), captureRadius: CAPTURE } : null);
  session.attachTransport(m => { if (m.type === 'route') { replans += 1; post('route-ack', dim.offer(m.route, world.time).ack); } });
  session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 'qa', seq: 0, startedAtWallMs: 0, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 1, modelVersion: 'fractured-2.0', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null });
  const frame = (scan: boolean) => { const f = world.frame(scan); seq += 1; const nav = strategy === 'atlas' ? dim.report(world.baymax, world.time, resolver) : null; session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...f, seq, ...(nav ? { nav } : {}) }); };
  world.baymax = [...start] as unknown as Vec3;
  for (let i = 0; i < warmup / 0.25; i += 1) { world.advance(0.25); wall += 250; frame(i % 2 === 1); }
  const e = session.memory.entity(CAPSULE);
  if (!e || e.knowledge !== 'current') return null;
  session.setSpeed(speed);
  if (strategy === 'atlas') { session.select(CAPSULE); if (!session.sendRoute()) return null; }
  let path = 0, closest = Infinity; const t0 = world.time;
  for (let i = 0; i < limit / 0.25; i += 1) {
    world.advance(0.25); wall += 250;
    let goal: Vec3 | null;
    if (strategy === 'atlas') { const r = dim.current(); goal = r && r.phase === 'active' ? r.route.waypoints[r.activeIndex]!.position as Vec3 : null; }
    else goal = (session.memory.entity(CAPSULE)?.position ?? null) as Vec3 | null;
    if (goal) { const d = dist(world.baymax, goal), k = Math.min(1, (speed * 0.25) / Math.max(d, 1e-6)); const nx = [0, 1, 2].map(j => world.baymax[j]! + (goal![j]! - world.baymax[j]!) * k) as unknown as Vec3; path += dist(world.baymax, nx); world.baymax = nx; }
    if (strategy === 'atlas') dim.update(world.baymax, world.time, resolver);
    closest = Math.min(closest, dist(world.baymax, world.truth(CAPSULE)));
    frame(i % 2 === 1);
    const cur = dim.current();
    const done = strategy === 'atlas' ? (cur?.phase === 'arrived' || cur?.phase === 'missed') : dist(world.baymax, world.truth(CAPSULE)) <= CAPTURE;
    if (done) {
      const o = cur?.outcome;
      return { strategy, speed, warmup, offset, phase: strategy === 'atlas' ? cur!.phase : 'arrived', success: strategy === 'atlas' ? cur!.phase === 'arrived' : true, seconds: world.time - t0, closest, replans, plannedError: o?.plannedError ?? null, plannedTime: o?.plannedSimTime ?? null, actualTime: o?.simTime ?? null, path };
    }
  }
  return { strategy, speed, warmup, offset, phase: 'timeout', success: false, seconds: limit, closest, replans, plannedError: null, plannedTime: null, actualTime: null, path };
}

const variant = process.env.VARIANT === 'fast' ? 'fast' : 'cruise';
const out = process.argv[2] ?? `docs/evidence/qa-final/science-${variant}.json`;
const small = process.env.GRID === 'small';
const warmups = small ? [12, 24, 40, 56] : [8, 12, 16, 20, 24, 30, 36, 44, 52, 60];
const offsets = small ? [[22, 6, 14], [-24, 8, -10], [4, -4, 28]] : [[22, 6, 14], [-24, 8, -10], [4, -4, 28], [-10, 14, -22]];
const speeds = process.env.SPEEDS ? process.env.SPEEDS.split(',').map(Number) : [6, 10, 14, 22];
const rows: Res[] = []; const pairKey: string[] = []; let skipped = 0;
for (const w of warmups) {
  const probe = new LiveWorld('probe', variant); probe.advance(w); const c = probe.truth(CAPSULE);
  for (const off of offsets) {
    const start = [c[0] + off[0]!, c[1] + off[1]!, c[2] + off[2]!] as unknown as Vec3;
    for (const sp of speeds) for (const s of ['atlas', 'chase'] as const) { const r = run(s, variant, start, sp, w, off[0]!); if (r) { rows.push(r); pairKey.push(`${w}|${off.join(',')}|${sp}`); } else skipped += 1; }
  }
}
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const summary: Record<string, unknown> = { variant, runs: rows.length, skippedNoCurrentObservation: skipped };
for (const s of ['atlas', 'chase'] as const) for (const sp of speeds) {
  const r = rows.filter(x => x.strategy === s && x.speed === sp), ok = r.filter(x => x.success);
  const pe = r.flatMap(x => (x.plannedError === null ? [] : [x.plannedError]));
  summary[`${s}@${sp}`] = { n: r.length, captured: ok.length, rate: +(ok.length / Math.max(r.length, 1)).toFixed(3), missed: r.filter(x => x.phase === 'missed').length, timeouts: r.filter(x => x.phase === 'timeout').length, meanTimeToCapture: +mean(ok.map(x => x.seconds)).toFixed(2), meanClosestAll: +mean(r.map(x => x.closest)).toFixed(2), maxClosestAll: +Math.max(...r.map(x => x.closest)).toFixed(2), meanReplans: +mean(r.map(x => x.replans)).toFixed(2), maxReplans: Math.max(...r.map(x => x.replans)), plannedErrN: pe.length, meanPlannedErr: +mean(pe).toFixed(2), maxPlannedErr: pe.length ? +Math.max(...pe).toFixed(2) : null };
}
const h2h = speeds.map(sp => {
  let af = 0, cf = 0, tie = 0, atlasOnly = 0, chaseOnly = 0;
  for (let i = 0; i + 1 < rows.length; i += 1) {
    if (rows[i]!.strategy !== 'atlas' || rows[i + 1]!.strategy !== 'chase' || rows[i]!.speed !== sp || pairKey[i] !== pairKey[i + 1]) continue;
    const a = rows[i]!, c = rows[i + 1]!;
    if (a.success && c.success) { if (a.seconds < c.seconds - 0.25) af += 1; else if (c.seconds < a.seconds - 0.25) cf += 1; else tie += 1; } else if (a.success) atlasOnly += 1; else if (c.success) chaseOnly += 1;
  }
  return { speed: sp, atlasFaster: af, chaseFaster: cf, tie, atlasOnlySucceeded: atlasOnly, chaseOnlySucceeded: chaseOnly };
});
summary.headToHead = h2h;
console.log(JSON.stringify(summary, null, 1));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
