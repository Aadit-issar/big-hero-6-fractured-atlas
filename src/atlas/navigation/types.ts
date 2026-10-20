import type { ObservedConnectionState, WorldVec3 } from '../../shared/atlasContract';

/** ATLAS Phase 4: evidence-aware navigation. Everything here is derived from ATLAS's own knowledge (sensor observations,
 * exploration memory and scene-object memory). Nothing refers to the simulation, its registry or any future state. */

export type NavNodeKind = 'observer' | 'island' | 'fold-entry' | 'fold-exit' | 'landmark';
/** current: observed in the latest accepted data. remembered: last-known only. */
export type NavNodeStatus = 'current' | 'remembered';
export type NavSource = 'sensor' | 'scene-scan' | 'derived';

export interface NavNode {
  readonly id: string;
  readonly kind: NavNodeKind;
  readonly label: string;
  readonly position: WorldVec3;
  readonly status: NavNodeStatus;
  readonly source: NavSource;
  readonly lastSeenAt: number;
  /** Ids of the memory records that support this node. */
  readonly evidence: readonly string[];
  /** A sensor-reported far fold endpoint has not been explored independently. */
  readonly independentlyObserved: boolean;
}

export type NavEdgeKind = 'fold-transition' | 'free-flight';
export interface NavEdge {
  readonly id: string;
  readonly kind: NavEdgeKind;
  readonly from: string;
  readonly to: string;
  /** Fold transitions are directed entry to exit. Free-flight candidates are usable both ways. */
  readonly directed: boolean;
  readonly length: number;
  /** Fold state at the last measurement (fold transitions only). */
  readonly foldState: ObservedConnectionState | null;
  /** When this edge's support was last measured; null for geometry with no measurement of its own. */
  readonly verifiedAt: number | null;
  readonly currentlyObserved: boolean;
  /** Fraction of a free-flight segment that lies within sensor reach of recorded observer positions (0 to 1). */
  readonly observedCoverage: number;
  /** Fraction of the segment that follows the recorded observer track. */
  readonly trackSupport: number;
  /** Highest local hazard reading taken near the segment, and how many readings that is. Null when none exist. */
  readonly nearbyHazard: { readonly max: number; readonly readings: number } | null;
  /** Things that are known to limit this edge (acquired objects or islands the straight segment passes near). */
  readonly constraints: readonly string[];
  /** Things that are not known about this edge. Always non-empty for free-flight candidates. */
  readonly unknowns: readonly string[];
  readonly evidence: readonly string[];
}

export interface NavGraph {
  readonly episode: number;
  readonly simTime: number | null;
  readonly nodes: readonly NavNode[];
  readonly edges: readonly NavEdge[];
  readonly sensorRange: number;
  readonly sceneScanRange: number;
  /** Observer positions at which ATLAS has actually taken sensor readings (used for coverage). */
  readonly coveragePoints: readonly WorldVec3[];
}

export interface NavPolicy {
  /** Observation age (simulation seconds) after which a measurement is stale for planning. */
  readonly staleAfter: number;
  /** Longest free-flight candidate considered between two known places. */
  readonly maxFreeFlight: number;
  /** Nearest known neighbours each node is offered a free-flight candidate to. */
  readonly neighbours: number;
  /** Allow routes through remembered (not currently observed) fold transitions; they are flagged for revalidation. */
  readonly allowRemembered: boolean;
}

/** Documented, deterministic cost weights. They rank candidates; they are not probabilities. */
export const NAV_WEIGHTS = {
  /** Each unit of geometric distance costs 1. */
  distance: 1,
  /** Extra cost per unit of free-flight length, scaled by the unobserved fraction of that segment. */
  unobservedPerUnit: 0.6,
  /** A flat cost for crossing a fold (a transition is a discrete commitment). */
  foldTransition: 12,
  /** Extra flat cost for an unstable fold. */
  foldUnstable: 40,
  /** Extra flat cost for a remembered or stale fold transition. */
  foldStale: 60,
  /** Flat cost for a free-flight segment that passes near an acquired object or island. */
  nearObstacle: 15,
  /** Discount for the fraction of a segment that follows the recorded observer track. */
  trackDiscount: 0.35,
} as const;

export const DEFAULT_POLICY: NavPolicy = { staleAfter: 8, maxFreeFlight: 140, neighbours: 4, allowRemembered: true };

export type SegmentSupport =
  /** A fold the sensor currently reports as open. */
  | 'observed-fold'
  /** A fold transition resting on a last-known record. */
  | 'remembered-fold'
  /** Free flight along recorded observer movement. */
  | 'recorded-track'
  /** Free flight between known places; clearance and hazard are unverified. */
  | 'unverified-approach';

export interface RouteSegment {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: NavEdgeKind;
  readonly support: SegmentSupport;
  readonly length: number;
  readonly cost: number;
  readonly caution: boolean;
  readonly notes: readonly string[];
}

export interface Route {
  readonly nodes: readonly string[];
  readonly segments: readonly RouteSegment[];
  readonly totalLength: number;
  readonly totalCost: number;
  /** Fold ids the route depends on, with the state each was last measured in. */
  readonly foldDependencies: readonly { readonly foldId: string; readonly state: ObservedConnectionState; readonly currentlyObserved: boolean }[];
  /** Oldest measurement the route depends on (null if it only rests on geometry). */
  readonly oldestSupportAge: number | null;
}

export type EvidenceKind = 'observation' | 'memory' | 'derived' | 'assumption';
export interface EvidenceItem { readonly kind: EvidenceKind; readonly text: string; readonly refs: readonly string[] }

export type FrontierKind = 'refresh-stale' | 'unexplored-exit' | 'coverage-edge';
export interface Frontier {
  readonly id: string;
  readonly kind: FrontierKind;
  readonly label: string;
  /** A position Baymax could move to in order to observe it. */
  readonly target: WorldVec3;
  readonly score: number;
  readonly distance: number;
  readonly reasons: readonly string[];
  readonly refs: readonly string[];
}

export type AdviceStatus = 'route' | 'needs-revalidation' | 'no-route' | 'explore' | 'abstain';

export interface Recommendation {
  readonly title: string;
  readonly detail: string;
  readonly target: WorldVec3 | null;
  readonly targetId: string | null;
  readonly action: 'follow-route' | 'observe' | 'refresh' | 'none';
}

export interface RoutePoint { readonly id: string; readonly label: string; readonly position: WorldVec3; readonly kind: NavNodeKind }

export interface NavigationAdvice {
  readonly status: AdviceStatus;
  readonly episode: number;
  readonly simTime: number | null;
  readonly goalId: string | null;
  readonly goalLabel: string | null;
  readonly route: Route | null;
  /** Route nodes with positions, in order (empty without a route). */
  readonly waypoints: readonly RoutePoint[];
  /** Every destination a user may select; only recorded entities appear. */
  readonly goals: readonly Goal[];
  readonly alternatives: readonly Route[];
  readonly frontiers: readonly Frontier[];
  readonly recommendation: Recommendation;
  readonly evidence: readonly EvidenceItem[];
  readonly limitations: readonly string[];
  /** Why no route was produced (when status is not route). */
  readonly reason: string | null;
}

export interface Goal { readonly id: string; readonly label: string; readonly kind: NavNodeKind; readonly position: WorldVec3; readonly status: NavNodeStatus }
