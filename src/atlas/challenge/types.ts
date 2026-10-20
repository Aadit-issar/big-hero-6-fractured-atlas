import type { WorldVec3 } from '../../shared/atlasContract';

/** The Moving Corridor challenge: shared vocabulary.
 *
 * INFORMATION BOUNDARY. Everything in this directory except `world.ts`, `fixtures.ts` and `evaluate.ts` is "ATLAS side": it may read only
 * accepted observations (through the runtime's exploration memory) and scene-scan memory. `world.ts` holds simulated truth and is the only
 * producer of observations; `evaluate.ts` is the only consumer of truth after the fact. tests/atlasChallenge.test.ts enforces the import boundary. */

export type Vec3 = WorldVec3;

/** Physical and planning constants of the challenge. Every number has a stated reason; none was tuned to a route. */
export interface ChallengeParams {
  /** Baymax approach speed (world units / s). Free flight is 14 u/s; a a careful approach into moving debris is far slower. */
  readonly speed: number;
  /** Baymax's clearance radius (world units). */
  readonly baymaxRadius: number;
  /** Nominal obstacle bound. The sensor reports no island extent; this prior sits above the documented rock bound of 5.7 u. */
  readonly obstacleBound: number;
  /** Extra clearance kept on top of radius and bound. */
  readonly margin: number;
}

export const CHALLENGE_PARAMS: ChallengeParams = Object.freeze({ speed: 3.0, baymaxRadius: 1.6, obstacleBound: 6.0, margin: 2.0 });
/** Clearance demanded of a static (persistence) planner: no motion uncertainty term. */
export const staticClearance = (p: ChallengeParams): number => p.baymaxRadius + p.obstacleBound + p.margin;

/** Documented route-cost weights. They rank candidates; they are not probabilities. */
export const PLAN_WEIGHTS = Object.freeze({
  /** One unit of path costs 1. */
  distance: 1,
  /** A turn costs this many path units per radian turned (about 2 units for a right angle: a change of heading is a small commitment). */
  turn: 1.3,
  /** Per unit of path whose obstacle predictions lie beyond the model horizon (verified only against a widening envelope). */
  unsupported: 0.5,
  /** A leg whose only conflict is with the widening envelope beyond a trust horizon costs this much extra: avoided when cheap, never required. */
  envelopeConflict: 20,
});

export interface TrackSample { readonly time: number; readonly position: Vec3; readonly breakBefore?: boolean }
