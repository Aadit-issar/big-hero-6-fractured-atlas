import { AtlasRuntime } from '../core/runtime';
import { sceneKnowledge } from '../live/knowledge';
import { SceneObjectMemory } from '../mapping/sceneObjectMemory';
import type { AtlasView } from '../core/runtime';
import type { SceneKnowledge } from '../live/knowledge';
import { AtlasAgent } from './atlasAgent';
import type { AgentStep, ForecastRecord, PlanDecision } from './atlasAgent';
import { ChallengeWorld } from './world';
import type { ScenarioSpec } from './world';
import type { Vec3 } from './types';

/** Closed-loop execution of the challenge: world -> sensor -> ATLAS runtime -> agent -> Baymax follows the committed route -> next tick.
 * Everything is recorded per tick so the presentation can scrub through it. Each recorded step reflects only what had been delivered by that tick. */

export interface TickRecord {
  readonly tick: number;
  readonly time: number;
  /** Baymax's position when this tick's observation was taken. */
  readonly baymax: Vec3;
  readonly heading: Vec3;
  readonly step: AgentStep;
  /** Positions reported by the sensor this tick (noisy, range limited). */
  readonly sensed: readonly { readonly id: string; readonly position: Vec3 }[];
  readonly forecastCount: number;
  readonly eventCount: number;
  /** What the scene-scan memory held after this tick (shared by reference while unchanged). */
  readonly scene: SceneKnowledge;
}
export interface ChallengeRun {
  readonly spec: ScenarioSpec;
  readonly ticks: readonly TickRecord[];
  readonly decisions: readonly PlanDecision[];
  /** Final forecast ledger (records carry the time they were scored; use `forecastsAt` for a historical view). */
  readonly forecasts: readonly ForecastRecord[];
  readonly events: readonly import('./atlasAgent').AgentEvent[];
  readonly world: ChallengeWorld;
  /** Knowledge views kept for presentation (islands' memory, scene records) at selected ticks are rebuilt on demand by `replayTo`. */
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** Position along a route polyline after flying `distance` from its first waypoint. */
export function pointOnRoute(waypoints: readonly Vec3[], distance: number): { position: Vec3; heading: Vec3 } {
  let left = Math.max(0, distance);
  for (let i = 0; i + 1 < waypoints.length; i += 1) {
    const a = waypoints[i]!, b = waypoints[i + 1]!, d = len(sub(b, a));
    const heading: Vec3 = d === 0 ? [0, 0, 1] : [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d];
    if (left <= d + 1e-9) return { position: [a[0] + heading[0] * left, a[1] + heading[1] * left, a[2] + heading[2] * left], heading };
    left -= d;
  }
  const last = waypoints.at(-1)!, prev = waypoints.at(-2) ?? last, d = len(sub(last, prev));
  return { position: last, heading: d === 0 ? [0, 0, 1] : [(last[0] - prev[0]) / d, (last[1] - prev[1]) / d, (last[2] - prev[2]) / d] };
}

export interface Session { readonly runtime: AtlasRuntime; readonly memory: SceneObjectMemory; readonly agent: AtlasAgent; readonly world: ChallengeWorld }

export function runChallenge(spec: ScenarioSpec, options: { readonly untilSeconds?: number; readonly onTick?: (record: TickRecord, view: AtlasView, scene: SceneKnowledge) => void } = {}): ChallengeRun {
  const world = new ChallengeWorld(spec);
  const runtime = new AtlasRuntime();
  const memory = new SceneObjectMemory();
  const agent = new AtlasAgent(spec.params, spec.observeSeconds);
  const total = Math.round((options.untilSeconds ?? spec.durationSeconds) * spec.tickHz);
  const ticks: TickRecord[] = [];
  let baymax: Vec3 = spec.start;
  let heading: Vec3 = (() => { const d = sub(spec.goal, spec.start), n = len(d) || 1; return [d[0] / n, d[1] / n, d[2] / n] as Vec3; })();
  for (let tick = 0; tick <= total; tick += 1) {
    const observation = world.observe(tick, baymax);
    const view = runtime.receive(observation, tick * (1000 / spec.tickHz));
    const scan = world.scan(tick, baymax);
    if (scan) memory.update(scan);
    const mem = memory.read();
    const scene = sceneKnowledge(mem.records, mem.scans);
    const step = agent.step({ tick, view, scene });
    const record: TickRecord = Object.freeze({
      tick, time: tick / spec.tickHz, baymax, heading, step,
      sensed: Object.freeze(observation.islands.map(i => ({ id: i.id, position: i.worldPosition as Vec3 }))), forecastCount: agent.forecasts.length, eventCount: agent.events.length, scene,
    });
    ticks.push(record);
    options.onTick?.(record, view, scene);
    // Baymax follows the committed route; between decisions he holds.
    if (step.route && step.routeStartTime !== null) {
      const next = (tick + 1) / spec.tickHz;
      const pts = [step.route.waypoints[0]!.position, ...step.route.waypoints.slice(1).map(w => w.position)];
      const flown = (next - step.routeStartTime) * spec.params.speed;
      const p = pointOnRoute(pts, flown);
      baymax = p.position; heading = p.heading;
    }
  }
  return { spec, ticks, decisions: agent.decisions, forecasts: agent.forecasts, events: agent.events, world };
}
