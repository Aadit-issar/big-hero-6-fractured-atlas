import { parseDimensionMessage } from './protocol';
import type { FrameMessage, RouteAckMessage, ScanMode, WelcomeMessage } from './protocol';

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'stale' | 'disconnected';

export interface LinkCounters { accepted: number; duplicate: number; foreignSession: number; malformed: number; badOrigin: number }
export interface LinkState {
  readonly status: LinkStatus;
  readonly session: string | null;
  /** Incremented whenever a different Dimension session is adopted. A new episode never continues the previous one. */
  readonly episode: number;
  readonly dimensionOrigin: string | null;
  readonly lastSeq: number;
  readonly lastFrameAtMs: number | null;
  readonly lastSimTime: number | null;
  readonly sensorRange: number | null;
  readonly scanRange: number | null;
  readonly scanMode: ScanMode | null;
  readonly counters: Readonly<LinkCounters>;
}

export type LinkEvent =
  | { readonly kind: 'ignored'; readonly reason: 'bad-origin' | 'malformed' | 'foreign-session' | 'duplicate' }
  | { readonly kind: 'welcome'; readonly welcome: WelcomeMessage; readonly newSession: boolean }
  | { readonly kind: 'frame'; readonly frame: FrameMessage }
  | { readonly kind: 'goal-request'; readonly goalId: string }
  | { readonly kind: 'route-ack'; readonly ack: RouteAckMessage };

export interface LinkPolicy {
  /** Exact origin of the Dimension window; null pins the first loopback origin that completes a handshake. */
  readonly expectedOrigin: string | null;
  readonly staleAfterMs?: number;
  readonly disconnectedAfterMs?: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function isLoopbackOrigin(origin: string): boolean {
  try { const u = new URL(origin); return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname); } catch { return false; }
}

/** Pure session/sequence state machine for the live link. No DOM, no timers: callers pass the current time. */
export class LinkCore {
  private status: LinkStatus = 'idle';
  private session: string | null = null;
  private episode = 0;
  private origin: string | null;
  private lastSeq = -1;
  private lastFrameAt: number | null = null;
  private lastSim: number | null = null;
  private sensorRange: number | null = null;
  private scanRange: number | null = null;
  private scanMode: ScanMode | null = null;
  private counters: LinkCounters = { accepted: 0, duplicate: 0, foreignSession: 0, malformed: 0, badOrigin: 0 };
  private connectingSince: number | null = null;
  private readonly staleAfterMs: number;
  private readonly disconnectedAfterMs: number;

  constructor(policy: LinkPolicy) {
    this.origin = policy.expectedOrigin;
    this.staleAfterMs = policy.staleAfterMs ?? 1500;
    this.disconnectedAfterMs = policy.disconnectedAfterMs ?? 6000;
  }

  /** Begin (or restart) a connection attempt. */
  beginConnecting(nowMs: number): void { this.status = 'connecting'; this.connectingSince = nowMs; }

  /** Close the link locally. The recorded session id stays visible for diagnostics, but nothing more is accepted. */
  close(): void { this.status = 'idle'; this.connectingSince = null; }

  handle(origin: string, data: unknown, nowMs: number): LinkEvent {
    if (this.status === 'idle') return { kind: 'ignored', reason: 'foreign-session' };
    const allowed = this.origin ? origin === this.origin : isLoopbackOrigin(origin);
    if (!allowed) { this.counters.badOrigin += 1; return { kind: 'ignored', reason: 'bad-origin' }; }
    const message = parseDimensionMessage(data);
    if (!message) { this.counters.malformed += 1; return { kind: 'ignored', reason: 'malformed' }; }
    if (message.type === 'welcome') {
      if (message.origin !== origin) { this.counters.badOrigin += 1; return { kind: 'ignored', reason: 'bad-origin' }; }
      const newSession = message.session !== this.session;
      if (newSession) { this.session = message.session; this.episode += 1; this.lastSeq = message.seq - 1; }
      this.origin = origin;
      this.sensorRange = message.sensorRange; this.scanRange = message.scanRange; this.scanMode = message.scanMode;
      this.lastSim = message.simTime; this.lastFrameAt = nowMs; this.status = 'connected'; this.connectingSince = null;
      return { kind: 'welcome', welcome: message, newSession };
    }
    if (message.session !== this.session) { this.counters.foreignSession += 1; return { kind: 'ignored', reason: 'foreign-session' }; }
    if (message.seq <= this.lastSeq) { this.counters.duplicate += 1; return { kind: 'ignored', reason: 'duplicate' }; }
    if (message.type === 'route-ack') { this.lastSeq = message.seq; this.counters.accepted += 1; return { kind: 'route-ack', ack: message }; }
    if (message.type === 'select-goal') { this.lastSeq = message.seq; this.counters.accepted += 1; return { kind: 'goal-request', goalId: message.goalId }; }
    this.lastSeq = message.seq; this.lastFrameAt = nowMs; this.lastSim = message.observation.time; this.scanMode = message.scanMode;
    this.status = 'connected'; this.counters.accepted += 1;
    return { kind: 'frame', frame: message };
  }

  /** Advance staleness. Returns true if the status changed. */
  tick(nowMs: number): boolean {
    const before = this.status;
    if (this.status === 'connected' || this.status === 'stale') {
      const age = nowMs - (this.lastFrameAt ?? nowMs);
      this.status = age > this.disconnectedAfterMs ? 'disconnected' : age > this.staleAfterMs ? 'stale' : 'connected';
    } else if (this.status === 'connecting' && this.connectingSince !== null && nowMs - this.connectingSince > this.disconnectedAfterMs) {
      this.status = 'disconnected';
    }
    return this.status !== before;
  }

  state(): LinkState {
    return {
      status: this.status, session: this.session, episode: this.episode, dimensionOrigin: this.origin, lastSeq: this.lastSeq, lastFrameAtMs: this.lastFrameAt, lastSimTime: this.lastSim,
      sensorRange: this.sensorRange, scanRange: this.scanRange, scanMode: this.scanMode, counters: { ...this.counters },
    };
  }
}
