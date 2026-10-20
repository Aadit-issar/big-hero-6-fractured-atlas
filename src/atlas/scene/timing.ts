import type { SceneModel } from './sceneModel';
import type { WorldVec3 } from '../../shared/atlasContract';

/** Speed of the visual scan pulse, world units per model second. Presentation only. */
export const PULSE_SPEED = 15;
export const REVEAL_SECONDS = 1.9;
export const PULSE_LIFE = 3.2;

export const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

export function distanceFromObserver(model: SceneModel, p: WorldVec3): number {
  const o = model.observer?.position;
  return o ? Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]) : 0;
}

/** Reveal progress of an entity first recorded at `firstSeenAt`: the pulse leaves the observer on arrival of the
 * observation, reaches the entity after distance / PULSE_SPEED, and the contour sweep follows. Purely derived
 * from the replay clock, so scrubbing backwards un-reveals deterministically. */
export function revealOf(model: SceneModel, firstSeenAt: number, position: WorldVec3): number {
  const arrival = firstSeenAt + distanceFromObserver(model, position) / PULSE_SPEED;
  return smooth((model.time - arrival) / REVEAL_SECONDS);
}
