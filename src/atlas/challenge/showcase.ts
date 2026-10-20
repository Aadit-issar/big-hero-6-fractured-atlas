import { buildPlacement } from './placements';
import type { PlacementParams } from './placements';

/** THE pinned showcase: "ATLAS — The Moving Corridor Challenge".
 *
 * Authoring (disclosed, see docs/ATLAS_CONTROLLED_CHALLENGE_SCIENCE.md):
 *  - Island A is real island-01 from real time 12 s. The corridor is laid across its path (placements.ts), 4.5 u off its centre line, so that at
 *    the moment of decision it is clear of the direct route (a static plan accepts the route) and it closes in as Baymax approaches.
 *  - Island B is real island-02 from real time 16 s, rotated about the vertical axis by -1.67 rad (a rigid rotation: same speed and shape of motion)
 *    so that it approaches the capsule from beyond sensor range. It is first sensed at about 10.5 s, after the first routing decision.
 *  - B's placement was chosen from an enumeration of candidate placements for one that produced a genuine, non-chattering replan. Nothing about the
 *    PLANNER was tuned to this case; the held-out placements of protocol D run the same planner unchanged. */
export const SHOWCASE_PLACEMENT: PlacementParams = {
  id: 'moving-corridor-v1', seed: 17062026,
  primary: { island: 'island-01', realStartSeconds: 12, lateralTruth: -4.5 },
  secondary: { island: 'island-02', realStartSeconds: 16, offsetFromGoal: [-7.78, 1.33, -15.67] as const, rotateY: -1.67 },
  crossingLength: 28, beyondLength: 22, observeSeconds: 10, durationSeconds: 48,
};
export const SHOWCASE_SPEC = buildPlacement(SHOWCASE_PLACEMENT);
