import { LinkCore } from '../live/linkCore';
import type { LinkState } from '../live/linkCore';
import { LINK_CHANNEL, LINK_VERSION } from '../live/protocol';
import type { FrameMessage, RouteAckMessage } from '../live/protocol';
import type { ClockReport, NavReport, ObservedDisturbance, PoseReport, RouteCommand } from '../../shared/liveLink';
import { ForecastBook, estimate, positionAt } from './forecast';
import type { Estimate, ForecastEvaluation, FrozenForecast } from './forecast';
import { buildTargets } from './targets';
import type { NavTarget } from './targets';
import { planToTarget, toRouteCommand } from './route';
import type { PlanOutcome } from './route';
import { decideReplan } from './replan';
import type { ActivePlan, ReplanTrigger } from './replan';
import { buildEncounter, buildForecast } from './encounter';
import type { Encounter, ForecastView } from './encounter';
import { WorldMemory } from './world';
import type { Entity, Vec3 } from './world';

/** Owns one live ATLAS Command session: the window link to a running Dimension, everything ATLAS has learned from it, the forecasts it has
 * frozen, the route it has proposed and the explanations of every decision. It never sees ground truth: all inputs are accepted frames.
 *
 * Time. ATLAS has no clock of its own. `now` is the simulation time of the newest accepted frame; wall time is used only for link health
 * and for smoothing the on-screen pose between frames. */

export type RouteState = 'none' | 'sent' | 'accepted' | 'rejected' | 'arrived' | 'missed' | 'cancelled';
export interface LogEntry { readonly id: number; readonly tone: 'info' | 'new' | 'warn' | 'route' | 'forecast'; readonly title: string; readonly detail: string; readonly simTime: number | null; readonly atWall: number }
/** A decision the replanner really made for the active route, so the UI can say "Route updated: ..." or "Forecast stable: route retained" without inventing it. */
export interface RouteDecision { readonly kind: 'updated' | 'retained'; readonly simTime: number; readonly trigger: ReplanTrigger; readonly reason: string }
export interface ScanPulse { readonly atWall: number; readonly origin: Vec3; readonly range: number }
export interface RouteView {
  readonly state: RouteState;
  readonly active: ActivePlan | null;
  readonly command: RouteCommand | null;
  readonly ackDetail: string;
  readonly nav: NavReport | null;
  readonly sentAtSim: number | null;
  readonly arrivedAtSim: number | null;
  /** Every revision issued for the current goal with the reason it was issued. */
  readonly history: readonly { readonly revision: number; readonly simTime: number; readonly reason: string; readonly meeting: Vec3 | null }[];
}

export interface CommandSnapshot {
  readonly version: number;
  readonly link: LinkState;
  readonly connected: boolean;
  readonly episode: number;
  readonly simTime: number;
  readonly clock: ClockReport | null;
  readonly pose: PoseReport | null;
  /** Wall-clock (performance.now, ms) when `pose` arrived: lets the scene smooth between 4 Hz frames. */
  readonly poseAtWall: number;
  readonly entities: readonly Entity[];
  readonly estimates: ReadonlyMap<string, Estimate>;
  readonly targets: readonly NavTarget[];
  readonly selectedId: string | null;
  readonly speed: number;
  readonly horizon: number;
  readonly plan: PlanOutcome | null;
  /** The forecast of the selected moving entity (same fit as the plan). Null when there is nothing to forecast. */
  readonly forecast: ForecastView | null;
  /** The encounter implied by the current plan (target now / at arrival, Baymax along the route). */
  readonly encounter: Encounter | null;
  /** Forecast-preview time chosen by the user in Predictive Analysis (simulation seconds), or null to follow the plan's arrival time. Never changes the world. */
  readonly scrubTime: number | null;
  readonly forecasts: readonly FrozenForecast[];
  readonly evaluations: ReadonlyMap<string, ForecastEvaluation>;
  readonly route: RouteView;
  readonly log: readonly LogEntry[];
  readonly pulses: readonly ScanPulse[];
  readonly fields: readonly ObservedDisturbance[];
  readonly scanPending: boolean;
  readonly lastScanSummary: string;
  readonly autoReplan: boolean;
  /** Most recently selected targets, newest first (for the quick-target catalogue). */
  readonly recentIds: readonly string[];
  /** The last replanning decision for the active route (updated or retained), or null. */
  readonly routeDecision: RouteDecision | null;
}

export interface SessionOptions { readonly dimensionUrl: string; readonly now?: () => number }
const MAX_LOG = 60;
/** Link-health messages are repeated by flapping links: the same title is shown at most once per this many wall milliseconds. */
const LINK_NOTE_TITLES = new Set(['Data stale', 'Dimension disconnected', 'Connecting to the Dimension', 'Pop-up blocked', 'Not sent']);
const LINK_NOTE_COOLDOWN_MS = 60000, SAME_NOTE_COOLDOWN_MS = 8000;

/** Whether a new log entry repeats a recent one: identical title and detail within a few seconds, or a link-health title within a minute. Pure. */
export function isRepeatedNote(log: readonly LogEntry[], title: string, detail: string, atWall: number): boolean {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i]!;
    const age = atWall - e.atWall;
    if (age > LINK_NOTE_COOLDOWN_MS) return false;
    if (e.title === title && ((LINK_NOTE_TITLES.has(title)) || (e.detail === detail && age <= SAME_NOTE_COOLDOWN_MS))) return true;
  }
  return false;
}
const EMPTY_ROUTE: RouteView = { state: 'none', active: null, command: null, ackDetail: '', nav: null, sentAtSim: null, arrivedAtSim: null, history: [] };

export class CommandSession {
  readonly memory = new WorldMemory();
  readonly book = new ForecastBook(1.0, 80);
  private core = new LinkCore({ expectedOrigin: null, staleAfterMs: 3500, disconnectedAfterMs: 9000 });
  private peer: WindowProxy | null = null;
  private listeners = new Set<() => void>();
  private timers: number[] = [];
  private snapshot!: CommandSnapshot;
  private version = 0;
  private log: LogEntry[] = [];
  private logId = 1;
  private pulses: ScanPulse[] = [];
  private fields: ObservedDisturbance[] = [];
  private estimates = new Map<string, Estimate>();
  private estimatedAt = -Infinity;
  private plan: PlanOutcome | null = null;
  private plannedAt = -Infinity;
  private selectedId: string | null = null;
  /** Free flight in the Dimension is 14 m/s (boost 42 m/s): the default planning speed is cruise. */
  private speed = 14;
  private horizon = 6;
  private autoReplan = true;
  private scrubTime: number | null = null;
  private recentIds: string[] = [];
  private routeDecision: RouteDecision | null = null;
  private route: RouteView = EMPTY_ROUTE;
  private revision = 0;
  private routeCounter = 0;
  private lastAutoForecastAt = -Infinity;
  private poseAtWall = 0;
  private scanRequest: string | null = null;
  private requestCounter = 0;
  private lastScanSummary = '';
  private dimensionSession: string | null = null;
  private helloAny = false;
  private readonly atlasSession: string;
  private readonly now: () => number;
  /** Test hook: every posted message (the window itself is not involved when injected). */
  private outbox: ((message: Record<string, unknown>) => void) | null = null;

  constructor(private readonly options: SessionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.atlasSession = `atlas-${Math.floor(this.now())}-${Math.floor(Math.random() * 1e6)}`;
    this.snapshot = this.build();
  }

  getSnapshot = (): CommandSnapshot => this.snapshot;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get dimensionUrl(): string { return this.options.dimensionUrl; }
  wall(): number { return this.now(); }

  // ---------- link ----------
  openDimension(): boolean {
    const popup = window.open(this.options.dimensionUrl, 'fractured-dimension');
    if (!popup) { this.note('warn', 'Pop-up blocked', 'The browser blocked the Dimension window. Allow pop-ups, or press L inside a running Dimension to open ATLAS linked to it.'); this.emit(); return false; }
    this.attach(popup);
    return true;
  }
  reconnect(): boolean { if (this.peer && !this.peer.closed) { this.attach(this.peer); return true; } return this.openDimension(); }
  /** ATLAS was opened by a running Dimension (its L key). The opener's origin is not known in advance, so only the handshake hello (a page-session id) is addressed to any origin;
   * everything after is bound to the origin of the answering Dimension, which must be loopback. */
  linkOpener(): boolean { if (!window.opener || window.opener.closed) return false; this.helloAny = true; this.attach(window.opener as WindowProxy); return true; }
  /** Tests inject a transport instead of a window. */
  attachTransport(send: (message: Record<string, unknown>) => void): void { this.outbox = send; this.core.beginConnecting(this.now()); }

  private attach(peer: WindowProxy): void {
    this.detach();
    this.peer = peer;
    this.core.beginConnecting(this.now());
    window.addEventListener('message', this.onMessage);
    this.timers.push(window.setInterval(() => this.hello(), 1000), window.setInterval(() => this.tick(), 250), window.setInterval(() => { if (this.core.state().status === 'connected') this.send({ type: 'ping' }); }, 2000));
    this.hello();
    this.note('info', 'Connecting to the Dimension', 'Handshake sent; waiting for the running Dimension to answer.');
    this.emit();
  }
  private hello(): void {
    if (!this.peer || this.peer.closed || this.core.state().status === 'connected') return;
    const target = this.core.state().dimensionOrigin ?? (this.helloAny ? '*' : this.expectedTarget());
    try { this.peer.postMessage({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'hello', atlasSession: this.atlasSession }, target); } catch { /* peer unavailable */ }
  }
  private expectedTarget(): string { try { return new URL(this.options.dimensionUrl).origin; } catch { return '*'; } }
  private send(message: Record<string, unknown>): boolean {
    const full = { channel: LINK_CHANNEL, v: LINK_VERSION, ...message };
    if (this.outbox) { this.outbox(full); return true; }
    const origin = this.core.state().dimensionOrigin;
    if (!this.peer || this.peer.closed || !origin) return false;
    try { this.peer.postMessage(full, origin); return true; } catch { return false; }
  }
  disconnect(): void {
    this.send({ type: 'bye' });
    this.detach();
    this.core.close();
    this.note('info', 'Disconnected', 'The link was closed from ATLAS. Knowledge acquired so far stays in memory as last-known.');
    this.emit();
  }
  dispose(): void { this.detach(); this.listeners.clear(); }
  private detach(): void {
    if (typeof window !== 'undefined') window.removeEventListener('message', this.onMessage);
    this.timers.forEach(t => window.clearInterval(t));
    this.timers = [];
  }
  private onMessage = (event: MessageEvent): void => {
    if (this.peer && event.source !== this.peer) return;
    this.receive(event.origin, event.data);
  };

  /** Entry point for every message from the Dimension (the window handler, and tests). */
  receive(origin: string, data: unknown): void {
    const result = this.core.handle(origin, data, this.now());
    if (result.kind === 'ignored') return;
    if (result.kind === 'welcome') {
      if (result.newSession) this.startEpisode(result.welcome.session, result.welcome.seed);
      this.emit();
      return;
    }
    if (result.kind === 'route-ack') { this.onAck(result.ack); return; }
    if (result.kind === 'goal-request') { this.select(result.goalId); return; }
    this.ingest(result.frame);
  }

  private startEpisode(session: string, seed: number): void {
    const again = this.core.state().episode > 1;
    this.memory.reset(); this.book.reset();
    this.estimates = new Map(); this.estimatedAt = -Infinity; this.plan = null; this.plannedAt = -Infinity;
    this.selectedId = null; this.recentIds = []; this.routeDecision = null; this.route = EMPTY_ROUTE; this.pulses = []; this.fields = []; this.scanRequest = null; this.lastScanSummary = ''; this.lastAutoForecastAt = -Infinity;
    this.dimensionSession = session;
    this.note('new', again ? 'New Dimension session' : 'Connected to the Dimension', again
      ? `Session ${session.slice(0, 8)} is a different run (seed ${seed}). Everything learned in the previous run, including its route, was discarded.`
      : `Linked to running Dimension session ${session.slice(0, 8)} (seed ${seed}). ATLAS knows only what its observations report.`);
  }

  private tick(): void {
    if (this.core.tick(this.now())) {
      const status = this.core.state().status;
      if (status === 'stale') this.note('warn', 'Data stale', 'No observation has arrived recently. Everything shown is the last accepted state.');
      else if (status === 'disconnected') this.note('warn', 'Dimension disconnected', 'The link is lost. Records stay as last-known; the route shown is no longer being followed.');
    }
    this.emit();
  }

  // ---------- observations ----------
  private ingest(frame: FrameMessage): void {
    const { newEntities, stale } = this.memory.ingest(frame);
    if (stale) return;
    const wall = this.now();
    this.poseAtWall = wall;
    const time = frame.observation.time;
    if (newEntities.length) {
      const shown = newEntities.map(id => this.memory.entity(id)).filter((e): e is Entity => !!e && e.kind !== 'swarm');
      if (shown.length) this.note('new', `${shown.length} new in memory`, shown.slice(0, 4).map(e => e.label).join(', ') + (shown.length > 4 ? ` and ${shown.length - 4} more` : ''));
    }
    if (frame.scan) {
      this.fields = [...(frame.scan.fields ?? [])];
      const manual = frame.scan.trigger === 'request';
      if (manual || newEntities.length) this.pulses = [...this.pulses.slice(-5), { atWall: wall, origin: frame.scan.observerPosition as Vec3, range: frame.scan.range }];
      if (frame.scan.requestId && frame.scan.requestId === this.scanRequest) {
        this.scanRequest = null;
        const fresh = newEntities.filter(id => this.memory.entity(id)?.kind !== 'swarm').length;
        this.lastScanSummary = `Scan at t ${time.toFixed(1)} s: ${frame.scan.objects.length} object${frame.scan.objects.length === 1 ? '' : 's'} in range, ${fresh} newly discovered.`;
        this.note('info', 'Scan complete', this.lastScanSummary);
      }
    }
    // Evaluate pending forecasts against observations that really contain the entity right now.
    for (const e of this.memory.all()) {
      if (e.knowledge !== 'current' || e.lastSeen !== time) continue;
      for (const ev of this.book.observe(e.id, time, e.position)) {
        const f = this.book.list().find(x => x.id === ev.forecastId)!;
        this.note('forecast', `Forecast checked: ${e.label}`, `The ${f.horizon.toFixed(0)} s forecast frozen at t ${f.issuedAt.toFixed(1)} s was off by ${ev.error.toFixed(1)} m; assuming it had not moved would have been off by ${ev.baselineError.toFixed(1)} m.`);
      }
    }
    if (frame.nav) this.onNav(frame.nav);
    this.refreshEstimates(time);
    this.autoForecast(time);
    this.replanTick(time);
    this.emit();
  }

  private motionCandidates(): string[] {
    const out: string[] = [];
    for (const e of this.memory.all()) {
      if (e.kind === 'swarm') continue;
      const track = this.memory.track(e.id);
      if (track.length < 6) continue;
      const last = track.at(-1)!;
      const back = track.find(s => s.time >= last.time - 4) ?? track[0]!;
      const d = Math.hypot(last.position[0] - back.position[0], last.position[1] - back.position[1], last.position[2] - back.position[2]);
      if (d > 0.9 || e.id === this.selectedId) out.push(e.id);
    }
    return out;
  }

  /** Fit motion models for entities that appear to move (throttled to 2 Hz of simulation time). */
  private refreshEstimates(time: number): void {
    if (time - this.estimatedAt < 0.45) return;
    this.estimatedAt = time;
    const next = new Map<string, Estimate>();
    for (const id of this.motionCandidates()) {
      const e = this.memory.entity(id)!;
      if (e.knowledge !== 'current' && id !== this.selectedId) continue;
      const fresh = estimate(id, this.memory.track(id), time);
      // A momentary gap in observation must not turn a moving object into a static one in the middle of a route: the last good model is kept
      // for a few seconds (its stated uncertainty keeps growing with the lead time, so it never claims more than it knew).
      const prev = this.estimates.get(id);
      next.set(id, !fresh.ok && prev?.ok && prev.fit && prev.motion === 'moving' && time - prev.fit.issuedAt < 4 ? prev : fresh);
    }
    // Entities not currently observed keep their last estimate only as a label of "was moving"; they are not forecast.
    this.estimates = next;
  }

  /** While a moving target is selected, freeze a forecast every 3 s of simulation time so evidence accumulates without the user doing anything. */
  private autoForecast(time: number): void {
    const id = this.selectedId;
    if (!id || time - this.lastAutoForecastAt < 3) return;
    const est = this.estimates.get(id), e = this.memory.entity(id);
    if (!est?.ok || est.motion !== 'moving' || !e || e.knowledge !== 'current') return;
    this.lastAutoForecastAt = time;
    this.book.issue(id, est, time, this.horizon, e.position, this.memory.track(id));
  }

  /** Freeze a forecast for the selected entity now (the "Inspect prediction" action). */
  freezeForecast(): FrozenForecast | null {
    const id = this.selectedId;
    const e = id ? this.memory.entity(id) : undefined;
    if (!id || !e) return null;
    const est = this.estimates.get(id) ?? estimate(id, this.memory.track(id), this.memory.now);
    const f = this.book.issue(id, est, this.memory.now, this.horizon, e.position, this.memory.track(id));
    if (f) this.note('forecast', `Forecast frozen: ${e.label}`, `Expected near (${f.position.map(v => v.toFixed(0)).join(', ')}) at t ${f.targetTime.toFixed(1)} s, ±${f.uncertainty.toFixed(1)} m. It will be compared with the next observation of the object at that time.`);
    else this.note('warn', 'No forecast', est.note);
    this.emit();
    return f;
  }

  // ---------- user actions ----------
  requestScan(): boolean {
    if (this.core.state().status !== 'connected' && !this.outbox) return false;
    this.requestCounter += 1;
    this.scanRequest = `scan-${this.atlasSession}-${this.requestCounter}`;
    const ok = this.send({ type: 'scan-request', requestId: this.scanRequest });
    this.emit();
    return ok;
  }
  setScanMode(mode: 'continuous' | 'manual'): void { this.send({ type: 'set-scan-mode', mode }); }

  select(id: string | null): void {
    if (id !== null && !this.memory.entity(id)) return;
    if (id === this.selectedId) return;
    this.selectedId = id;
    if (id) this.recentIds = [id, ...this.recentIds.filter(r => r !== id)].slice(0, 6);
    this.routeDecision = null;
    this.plan = null; this.plannedAt = -Infinity; this.lastAutoForecastAt = -Infinity; this.scrubTime = null;
    this.estimatedAt = -Infinity;
    this.refreshEstimates(this.memory.now);
    this.recomputePlan(this.memory.now);
    this.emit();
  }
  setSpeed(speed: number): void {
    const v = Math.max(4, Math.min(42, speed));
    if (v === this.speed) return;
    this.speed = v; this.plannedAt = -Infinity;
    this.recomputePlan(this.memory.now);
    this.replanTick(this.memory.now);
    this.emit();
  }
  setScrubTime(t: number | null): void { this.scrubTime = t; this.emit(); }
  setHorizon(h: number): void { this.horizon = Math.max(2, Math.min(20, h)); this.emit(); }
  setAutoReplan(v: boolean): void { this.autoReplan = v; this.emit(); }

  private recomputePlan(time: number): void {
    const pose = this.memory.pose;
    if (!this.selectedId || !pose) { this.plan = null; return; }
    this.plan = planToTarget({ memory: this.memory, targetId: this.selectedId, baymax: pose.position as Vec3, speed: this.speed, now: time, estimates: this.estimates });
    this.plannedAt = time;
  }

  private replanTick(time: number): void {
    if (!this.selectedId || !this.memory.pose) return;
    if (time - this.plannedAt < 0.45) return;
    this.recomputePlan(time);
    const active = this.route.active;
    if (!this.autoReplan || !active || (this.route.state !== 'accepted' && this.route.state !== 'sent') || !this.plan || active.targetId !== this.selectedId) return;
    const target = this.memory.entity(this.selectedId)!;
    const decision = decideReplan(active, this.plan, this.memory.pose.position as Vec3, time, target.label);
    if (decision.replan) { this.sendRoute(decision.reason); this.routeDecision = { kind: 'updated', simTime: time, trigger: decision.trigger, reason: decision.reason }; }
    else if (this.plan.status === 'ready' && time - active.issuedAt >= 1.5) this.routeDecision = { kind: 'retained', simTime: time, trigger: 'none', reason: 'The latest forecast agrees with the route that was sent.' };
  }

  /** Send the current plan to Baymax. Each call is a new revision; the Dimension ignores anything older than what it has accepted. */
  sendRoute(reason?: string): boolean {
    const pose = this.memory.pose;
    if (!this.selectedId || !pose || !this.dimensionSession) return false;
    this.recomputePlan(this.memory.now);
    const plan = this.plan;
    if (!plan || plan.status !== 'ready') { this.note('warn', 'No route to send', plan?.reasons[0] ?? 'The destination cannot be planned yet.'); this.emit(); return false; }
    if (reason === undefined) this.routeDecision = null;
    const previous = this.route.active;
    const sameGoal = previous?.targetId === plan.targetId && (this.route.state === 'accepted' || this.route.state === 'sent');
    this.revision += 1;
    if (!sameGoal) this.routeCounter += 1;
    const routeId = sameGoal ? previous!.routeId : `route-${this.atlasSession.slice(-6)}-${this.routeCounter}`;
    const why = reason ?? (plan.mode === 'intercept' ? `Interception planned: ${plan.reasons[1] ?? plan.reasons[0] ?? ''}` : plan.reasons[0] ?? 'Route planned.');
    const command = toRouteCommand(plan, { routeId, revision: this.revision, atlasSession: this.atlasSession, supersedes: sameGoal ? previous!.revision : null }, why);
    if (!command) return false;
    const waypoints: Vec3[] = [pose.position as Vec3, ...plan.waypoints.map(w => w.position as Vec3)];
    const active: ActivePlan = {
      routeId, revision: this.revision, targetId: plan.targetId, issuedAt: plan.now, speed: plan.speed, meetingPosition: plan.mode === 'intercept' ? plan.meetingPosition : null, meetingTime: plan.meetingTime,
      goalPosition: plan.meetingPosition ?? plan.targetNow, waypoints, mode: plan.mode,
    };
    const before = this.route;
    // The route view is installed BEFORE posting: an acknowledgement can arrive synchronously.
    this.route = {
      state: 'sent', active, command, ackDetail: 'Waiting for the Dimension to acknowledge…', nav: before.nav, sentAtSim: sameGoal ? before.sentAtSim : plan.now, arrivedAtSim: null,
      history: [...(sameGoal ? before.history : []), { revision: this.revision, simTime: plan.now, reason: why, meeting: plan.meetingPosition }].slice(-12),
    };
    if (!this.send({ type: 'route', session: this.dimensionSession, route: command })) {
      this.route = before;
      this.note('warn', 'Not sent', 'The Dimension window is not reachable.'); this.emit(); return false;
    }
    this.note('route', sameGoal ? `Route updated (r${this.revision})` : `Route sent (r${this.revision})`, why);
    this.emit();
    return true;
  }

  cancelRoute(): void {
    const a = this.route.active;
    if (!a || !this.dimensionSession) return;
    this.send({ type: 'route-cancel', session: this.dimensionSession, routeId: a.routeId, revision: this.revision });
    this.route = { ...this.route, state: 'cancelled', ackDetail: 'Cancelled from ATLAS.' };
    this.note('route', 'Route cancelled', 'Guidance was withdrawn from the Dimension.');
    this.emit();
  }

  private onAck(ack: RouteAckMessage): void {
    const a = this.route.active;
    if (!a || ack.routeId !== a.routeId) return;
    if (ack.status === 'accepted' && ack.revision === a.revision) { this.route = { ...this.route, state: this.route.state === 'arrived' ? 'arrived' : 'accepted', ackDetail: `Acknowledged by the Dimension at t ${ack.simTime.toFixed(1)} s.` }; this.note('route', `Dimension accepted r${ack.revision}`, 'Its navigation guidance is now active.'); }
    else if (ack.status === 'rejected' && ack.revision === a.revision) {
      // A stale-revision rejection states the revision the Dimension already holds from this page (another sender, or a lost message): continue above it.
      const known = ack.code === 'stale-revision' ? Number(/accepted revision (\d+)/.exec(ack.detail)?.[1]) : NaN;
      if (Number.isFinite(known) && known >= this.revision) { this.revision = known; this.note('warn', `Dimension holds r${known}`, 'ATLAS continues numbering above it and re-sends the current plan.'); this.route = { ...this.route, state: 'rejected', ackDetail: ack.detail }; this.emit(); this.sendRoute(this.route.history.at(-1)?.reason ?? undefined); return; }
      this.route = { ...this.route, state: 'rejected', ackDetail: ack.detail }; this.note('warn', `Dimension rejected r${ack.revision}`, ack.detail);
    }
    this.emit();
  }

  private onNav(nav: NavReport): void {
    const a = this.route.active;
    if (!a || nav.routeId !== a.routeId) return;
    let state = this.route.state;
    let arrivedAtSim = this.route.arrivedAtSim;
    if (nav.status === 'arrived' && nav.revision >= a.revision - 0 && state !== 'arrived') {
      state = 'arrived'; arrivedAtSim = nav.arrivedAtSimTime;
      const issued = this.route.sentAtSim ?? a.issuedAt;
      this.note('route', 'Objective reached', `Baymax reached the target ${(Math.max(0, (nav.arrivedAtSimTime ?? this.memory.now) - issued)).toFixed(1)} s after the route was first sent; remaining distance ${nav.distanceToGoal.toFixed(1)} m.`);
    } else if (nav.status === 'missed' && state !== 'missed') {
      state = 'missed';
      const o = nav.outcome;
      this.note('warn', 'Rendezvous missed', o ? `Closest approach ${o.closestApproach.toFixed(1)} m (capture radius ${o.captureRadius.toFixed(1)} m).` : 'The route ended without reaching the target.');
    } else if (nav.status === 'active' && state === 'sent' && nav.revision === a.revision) state = 'accepted';
    this.route = { ...this.route, nav, state, arrivedAtSim };
  }

  // ---------- notes / snapshot ----------
  private note(tone: LogEntry['tone'], title: string, detail: string): void {
    const atWall = this.now();
    if (isRepeatedNote(this.log, title, detail, atWall)) return;
    this.log.push({ id: this.logId += 1, tone, title, detail, simTime: this.memory.now, atWall });
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  private build(): CommandSnapshot {
    this.version += 1;
    const link = this.core.state();
    const entities = this.memory.snapshot();
    const time = this.memory.now;
    const evals = new Map<string, ForecastEvaluation>();
    const forecasts = this.book.list(this.selectedId ?? undefined);
    for (const f of forecasts) { const ev = this.book.evaluation(f.id); if (ev) evals.set(f.id, ev); }
    const live = link.status === 'connected' || link.status === 'stale';
    return {
      version: this.version, link, connected: link.status === 'connected' || !!this.outbox, episode: link.episode, simTime: time, clock: this.memory.clock, pose: this.memory.pose, poseAtWall: this.poseAtWall,
      entities, estimates: this.estimates, targets: buildTargets(entities, time, this.estimates), selectedId: this.selectedId, speed: this.speed, horizon: this.horizon,
      plan: live || this.outbox ? this.plan : this.plan, ...this.views(entities, time), scrubTime: this.scrubTime, forecasts, evaluations: evals, route: this.route, log: [...this.log], pulses: [...this.pulses], fields: this.fields,
      scanPending: this.scanRequest !== null, lastScanSummary: this.lastScanSummary, autoReplan: this.autoReplan, recentIds: this.recentIds, routeDecision: this.routeDecision,
    };
  }

  private views(entities: readonly Entity[], time: number): { forecast: ForecastView | null; encounter: Encounter | null } {
    const id = this.selectedId;
    const entity = id ? entities.find(e => e.id === id) : undefined;
    if (!id || !entity) return { forecast: null, encounter: null };
    const est = this.estimates.get(id), track = this.memory.track(id);
    const baymax = (this.memory.pose?.position ?? entity.position) as Vec3;
    const encounter = this.plan && this.plan.targetId === id ? buildEncounter(this.plan, entity, est, track, baymax) : null;
    const until = Math.max(time + this.horizon, encounter ? Math.max(encounter.arrivalTime, encounter.aimTime) : 0);
    return { forecast: buildForecast(entity, est, track, time, until), encounter };
  }

  /** The live forecast (not frozen) of the selected entity at now + horizon, for the ghost. */
  ghost(): { position: Vec3; uncertainty: number; supported: boolean; targetTime: number } | null {
    const id = this.selectedId; if (!id) return null;
    const est = this.estimates.get(id);
    if (!est?.ok || !est.fit || est.motion !== 'moving') return null;
    const t = this.memory.now + this.horizon;
    return { ...positionAt(est.fit, t), targetTime: t };
  }

  private emit(): void { this.snapshot = this.build(); this.listeners.forEach(l => l()); }
}
