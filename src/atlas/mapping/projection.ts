import type { WorldVec3 } from '../../shared/atlasContract';

/** World-aligned map planes. The side elevation preserves both Y and Z axes. */
export type MapProjection = 'xz' | 'zy';

export function projectWorldPosition(position: WorldVec3, projection: MapProjection): readonly [number, number] {
  return projection === 'xz' ? [position[0], position[2]] : [position[2], position[1]];
}

/** Three-dimensional Euclidean separation in the contract's world units. */
export function worldDistance3D(a: WorldVec3, b: WorldVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
