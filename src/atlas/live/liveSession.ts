import { AtlasRuntime } from '../core/runtime';
import { SceneObjectMemory } from '../mapping/sceneObjectMemory';
import type { SceneScanSummary } from '../mapping/sceneObjectMemory';
import { NavigationRuntime } from '../navigation/advisor';
import type { NavChange } from '../navigation/advisor';
import type { NavigationAdvice } from '../navigation/types';
import { LinkCore } from './linkCore';
import type { LinkState } from './linkCore';
import { ADVISORY_VERSION, LINK_CHANNEL, LINK_VERSION } from './protocol';
import type { AdvisoryPayload, FrameMessage, ScanMode } from './protocol';
import { activityFromRuntimeEvent, activityFromSceneEvent, NO_SCENE_KNOWLEDGE, sceneKnowledge } from './knowledge';
import type { ActivityEntry, KnowledgeSnapshot, ScanPulse } from './knowledge';

export interface LiveSnapshot extends KnowledgeSnapshot {
  readonly source: 'live-linked';
  readonly link: LinkState;
  readonly episode: number;
  readonly lastScan: SceneScanSummary | null;
  /** True for a short moment after a scan request until its result arrives. */
  readonly scanPending: boolean;
  readonly dimensionUrl: string;
  readonly navigation: { readonly advice: NavigationAdvice; readonly goalId: string | null; readonly changes: readonly NavChange[] };
}

export interface LiveSessionOptions {
  readonly dimensionUrl: string;
  /** Pin the Dimension origin up front (when ATLAS opens it); otherwise the first loopback origin that handshakes. */
  readonly expectedOrigin?: string | null;
  readonly now?: () => number;
}

const MAX_ACTIVITY = 40;
const EMPTY_ADVICE: NavigationAdvice = {
  status: 'abstain', episode: 0, simTime: null, goalId: null, goalLabel: null, route: null, waypoints: [], goals: [], alternatives: [], frontiers: [],
  recommendation: { title: 'Waiting for observations', detail: 'ATLAS has not recorded where Baymax is.', target: null, targetId: null, action: 'none' }, evidence: [], limitations: [], reason: 'no observer position has been recorded',
};

/** Owns one live connection to a running Dimension: the window link, the ATLAS runtime fed by accepted frames,
 * the scene-object memory and the activity feed. A different Dimension session always starts a fresh episode. */
export class LiveSession {
  private core: LinkCore;
  private runtime = new AtlasRuntime();
  private memory = new SceneObjectMemory();
  private activity: ActivityEntry[] = [];
  private appear = new Map<string, number>();
  private lastEventId = 0;
  private nextActivityId = 1;
  private lastScan: SceneScanSummary | null = null;
  private lastScanAtS: number | null = null;
  private pulses: ScanPulse[] = [];
  private nav = new NavigationRuntime();
  private navAdvice: NavigationAdvice | null = null;
  private navChanges: NavChange[] = [];
  private advisorySeq = 0;
  private advisorySig = '';
  private advisoryAt = 0;
  private pendingRequest: string | null = null;
  private requestCounter = 0;
  private peer: WindowProxy | null = null;
  private listeners = new Set<() => void>();
  private timers: number[] = [];
  private snapshot: LiveSnapshot;
  private readonly t0: number;
  private readonly now: () => number;

  constructor(private readonly options: LiveSessionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.t0 = this.now();
    this.core = new LinkCore({ expectedOrigin: options.expectedOrigin ?? null });
    this.snapshot = this.build();
  }

  private wallMs(): number { return this.now() - this.t0; }
  private nowS(): number { return this.wallMs() / 1000; }

  presentationNow = (): number => this.nowS();
  wallNow = (): number => this.wallMs();
  getSnapshot = (): LiveSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Open the Dimension in its own window and link to it. Must be called from a user gesture. */
  openDimension(): boolean {
    const popup = window.open(this.options.dimensionUrl, 'fractured-dimension');
    if (!popup) { this.log('link', 'warn', 'Pop-up blocked', 'The browser blocked the Dimension window. Allow pop-ups for this page or press L inside the Dimension.'); this.emit(); return false; }
    this.attach(popup);
    return true;
  }

  /** Re-handshake with the Dimension window that is still open, without reloading it: the same session continues and memory is kept.
   * If that window is gone, open the Dimension again (which is a new session). */
  reconnect(): boolean {
    if (this.peer && !this.peer.closed) { this.attach(this.peer); return true; }
    return this.openDimension();
  }

  /** Link to the window that opened ATLAS (the Dimension pressing L). */
  linkOpener(): boolean {
    if (!window.opener || window.opener.closed) return false;
    this.attach(window.opener as WindowProxy);
    return true;
  }

  private attach(peer: WindowProxy): void {
    this.detach();
    this.peer = peer;
    this.core.beginConnecting(this.wallMs());
    window.addEventListener('message', this.onMessage);
    this.timers.push(window.setInterval(() => this.hello(), 1000), window.setInterval(() => this.tick(), 250));
    this.hello();
    this.log('link', 'info', 'Connecting to Dimension', 'Handshake sent. Waiting for the running Dimension to answer.');
    this.emit();
  }

  private hello(): void {
    if (!this.peer || this.peer.closed) return;
    // Retry until welcomed, and again whenever frames stop (a reloaded Dimension has forgotten this window).
    const status = this.core.state().status;
    if (status === 'connected') return;
    const target = this.core.state().dimensionOrigin ?? this.expectedTarget();
    try { this.peer.postMessage({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'hello', atlasSession: 'atlas-' + this.t0.toFixed(0) }, target); } catch { /* peer unavailable */ }
  }

  private expectedTarget(): string {
    try { return new URL(this.options.dimensionUrl).origin; } catch { return '*'; }
  }

  private send(message: Record<string, unknown>): void {
    const origin = this.core.state().dimensionOrigin;
    if (!this.peer || this.peer.closed || !origin) return;
    try { this.peer.postMessage({ channel: LINK_CHANNEL, v: LINK_VERSION, ...message }, origin); } catch { /* ignore */ }
  }

  /** Ask the Dimension for one scan at the observer's current pose. */
  requestScan(): string | null {
    if (this.core.state().status !== 'connected') return null;
    this.requestCounter += 1;
    this.pendingRequest = `scan-${this.requestCounter}`;
    this.send({ type: 'scan-request', requestId: this.pendingRequest });
    this.emit();
    return this.pendingRequest;
  }

  setScanMode(mode: ScanMode): void { this.send({ type: 'set-scan-mode', mode }); }

  disconnect(): void {
    this.send({ type: 'bye' });
    this.detach();
    this.core.close();
    this.log('link', 'info', 'Disconnected', 'The live link was closed from ATLAS. Records already acquired remain in memory.');
    this.emit();
  }

  dispose(): void { this.detach(); this.listeners.clear(); }

  private detach(): void {
    window.removeEventListener('message', this.onMessage);
    this.timers.forEach(t => window.clearInterval(t));
    this.timers = [];
  }

  private onMessage = (event: MessageEvent): void => {
    if (this.peer && event.source !== this.peer) return;
    const wall = this.wallMs();
    const result = this.core.handle(event.origin, event.data, wall);
    if (result.kind === 'ignored') return;
    if (result.kind === 'welcome') {
      if (result.newSession) this.startEpisode(result.welcome.session);
      this.emit();
      return;
    }
    if (result.kind === 'goal-request') { this.setGoal(result.goalId, true); return; }
    if (result.kind === 'route-ack') return;
    this.ingest(result.frame, wall);
  };

  private startEpisode(session: string): void {
    const previous = this.core.state().episode > 1;
    this.runtime = new AtlasRuntime();
    this.memory.reset();
    this.appear = new Map();
    this.lastEventId = 0;
    this.lastScan = null; this.lastScanAtS = null; this.pendingRequest = null; this.pulses = [];
    // Guidance never carries across Dimension sessions: the goal and every earlier route are dropped.
    this.nav = new NavigationRuntime(); this.navAdvice = null; this.navChanges = []; this.advisorySig = '';
    this.log('link', 'new', previous ? 'New Dimension session' : 'Connected to Dimension', previous
      ? `Session ${session.slice(0, 8)} is a different run. ATLAS started a new episode and did not continue the previous records.`
      : `Linked to running Dimension session ${session.slice(0, 8)}. Observations now come from that world.`);
  }

  private ingest(frame: FrameMessage, wall: number): void {
    const at = this.nowS();
    const view = this.runtime.receive(frame.observation, wall);
    for (const e of view.events.slice().reverse()) {
      if (e.id <= this.lastEventId) continue;
      const entry = activityFromRuntimeEvent(e, view, at, this.nextActivityId);
      if (entry) { this.push(entry); }
    }
    this.lastEventId = Math.max(this.lastEventId, ...view.events.map(e => e.id), 0);
    for (const i of view.mapping.islands) if (!this.appear.has(i.id)) this.appear.set(i.id, at);
    for (const f of view.mapping.folds) if (!this.appear.has(f.id)) this.appear.set(f.id, at);
    if (!this.appear.has('baymax-observer') && view.mapping.explorer.latestPosition) this.appear.set('baymax-observer', at);
    const newEntity = [...view.mapping.islands, ...view.mapping.folds].some(e => this.appear.get(e.id) === at);
    if (newEntity && this.pulseGap(at)) this.pulses = [...this.pulses.slice(-7), { atS: at, range: 45 }];
    if (frame.scan) {
      const events = this.memory.update(frame.scan);
      const manual = frame.scan.trigger === 'request';
      const summary = this.memory.read().scans.at(-1) ?? null;
      this.lastScan = summary; this.lastScanAtS = at;
      for (const r of this.memory.read().records) if (!this.appear.has(r.id)) this.appear.set(r.id, at);
      const changes = events.filter(e => e.kind !== 'scene-scan-unchanged' && e.kind !== 'scene-scan-empty');
      if (changes.length > 0 || manual) for (const e of (changes.length > 0 ? changes : events)) this.push(activityFromSceneEvent(e, at, this.nextActivityId));
      if (manual || (changes.length > 0 && this.pulseGap(at))) this.pulses = [...this.pulses.slice(-7), { atS: at, range: frame.scan.range }];
      if (frame.scan.requestId && frame.scan.requestId === this.pendingRequest) this.pendingRequest = null;
    }
    this.updateNavigation();
    this.emit();
  }

  /** Select a destination (or clear it). A goal is accepted only if it is among the places ATLAS has recorded in this episode. */
  setGoal(id: string | null, fromDimension = false): boolean {
    if (id !== null && !this.navAdvice?.goals.some(g => g.id === id)) return false;
    this.nav.setGoal(id);
    this.navChanges = [];
    this.advisorySig = '';
    this.updateNavigation();
    if (fromDimension) this.log('navigation', 'info', 'Destination chosen in the Dimension', id ? `Guidance now targets ${this.navAdvice?.goalLabel ?? id}.` : 'Destination cleared.');
    this.emit();
    return true;
  }

  private updateNavigation(): void {
    const mem = this.memory.read();
    const view = this.runtime.getView(this.wallMs());
    const { advice, changes } = this.nav.update({ view, scene: sceneKnowledge(mem.records, mem.scans), episode: this.core.state().episode });
    this.navAdvice = advice;
    for (const c of changes) {
      this.navChanges = [...this.navChanges.slice(-4), c];
      const tone = c.kind === 'route-withdrawn' || c.kind === 'route-needs-revalidation' || c.kind === 'fold-state-changed' ? 'warn' : c.kind === 'route-found' || c.kind === 'route-refreshed' ? 'new' : 'info';
      this.push({ id: this.nextActivityId, kind: 'navigation', tone, title: c.kind.replace(/-/g, ' ').replace(/^./, x => x.toUpperCase()), detail: c.message, simTime: c.simTime, atS: this.nowS(), ...(advice.goalId ? { focusId: advice.goalId } : {}) });
    }
    this.sendAdvisory(advice);
  }

  /** Publishes the current guidance to the linked Dimension: only when it changed, plus a 2 s heartbeat so the Dimension can tell it is fresh. */
  private sendAdvisory(advice: NavigationAdvice): void {
    const state = this.core.state();
    if (state.status !== 'connected' || !state.session) return;
    const sig = [advice.status, advice.goalId, advice.route?.nodes.join('>'), advice.recommendation.target?.map(v => Math.round(v / 2)).join(','), advice.episode].join('|');
    const now = this.wallMs();
    if (sig === this.advisorySig && now - this.advisoryAt < 2000) return;
    this.advisorySig = sig; this.advisoryAt = now;
    const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const route = advice.route;
    const payload: AdvisoryPayload = {
      status: advice.status, episode: advice.episode, simTime: advice.simTime, goal: advice.goalId ? { id: advice.goalId, label: cut(advice.goalLabel ?? advice.goalId, 80) } : null,
      title: cut(advice.recommendation.title, 120), detail: cut(advice.recommendation.detail, 240), action: advice.recommendation.action,
      target: advice.recommendation.target ? [advice.recommendation.target[0], advice.recommendation.target[1], advice.recommendation.target[2]] : null,
      waypoints: advice.waypoints.slice(0, 8).map(w => [w.position[0], w.position[1], w.position[2]] as const),
      segments: route ? route.segments.slice(0, 8).map(sg => ({ kind: sg.kind === 'fold-transition' ? 'fold' as const : sg.support === 'recorded-track' ? 'track' as const : 'approach' as const, caution: sg.caution, remembered: sg.support === 'remembered-fold' })) : [],
      limitations: advice.limitations.slice(0, 2).map(l => cut(l, 160)),
      goals: advice.goals.filter(g => g.kind !== 'fold-exit').slice(0, 12).map(g => ({ id: g.id, label: cut(g.label, 60) })),
    };
    this.advisorySeq += 1;
    this.send({ type: 'advisory', advisoryVersion: ADVISORY_VERSION, session: state.session, seq: this.advisorySeq, ...payload });
  }

  /** At most one automatic pulse every 2.5 presentation seconds, so continuous flight does not stack rings. */
  private pulseGap(at: number): boolean { const last = this.pulses.at(-1); return !last || at - last.atS >= 2.5; }

  private push(entry: ActivityEntry): void {
    this.nextActivityId += 1;
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
  }

  private log(kind: ActivityEntry['kind'], tone: ActivityEntry['tone'], title: string, detail: string): void {
    this.push({ id: this.nextActivityId, kind, tone, title, detail, simTime: this.core.state().lastSimTime, atS: this.nowS() });
  }

  private tick(): void {
    if (this.core.tick(this.wallMs())) {
      const after = this.core.state().status;
      if (after === 'stale') this.log('link', 'warn', 'Data stale', 'No observation has arrived recently. Everything shown is the last accepted state.');
      else if (after === 'disconnected') this.log('link', 'warn', 'Dimension disconnected', 'The link is lost. Records stay in memory and are marked as last-known; no new data is being received.');
    }
    // The runtime recomputes sensor health from wall time; refresh the view so that status shows stale correctly.
    this.emit();
  }

  private build(): LiveSnapshot {
    const link = this.core.state();
    const view = this.runtime.getView(this.wallMs());
    const mem = this.memory.read();
    return {
      source: 'live-linked', view, scene: mem.records.length || mem.scans.length ? sceneKnowledge(mem.records, mem.scans) : NO_SCENE_KNOWLEDGE,
      activity: [...this.activity], appear: new Map(this.appear), lastScanAtS: this.lastScanAtS, pulses: [...this.pulses], link, episode: link.episode, lastScan: this.lastScan,
      scanPending: this.pendingRequest !== null, dimensionUrl: this.options.dimensionUrl,
      navigation: { advice: this.navAdvice ?? EMPTY_ADVICE, goalId: this.nav.getGoal(), changes: [...this.navChanges] },
      ...(this.navAdvice ? { } : {}),
    };
  }

  private emit(): void {
    this.snapshot = this.build();
    this.listeners.forEach(l => l());
  }
}
