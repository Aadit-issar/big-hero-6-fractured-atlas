import { describe, expect, it } from 'vitest';
import { createIslandGeometry } from '../src/scene/islandGeometry';

describe('procedural island geometry', () => {
  it('builds repeatable, finite rock meshes from each facet seed', () => {
    const first = createIslandGeometry(1717, 3.2, 1.8);
    const second = createIslandGeometry(1717, 3.2, 1.8);
    const positions = first.getAttribute('position').array;
    const normals = first.getAttribute('normal').array;

    expect(first.getAttribute('position').count).toBeGreaterThan(500);
    expect(Array.from(positions)).toEqual(Array.from(second.getAttribute('position').array));
    expect(Array.from(positions).every(Number.isFinite)).toBe(true);
    expect(Array.from(normals).every(Number.isFinite)).toBe(true);
    expect(first.groups).toHaveLength(2);

    first.dispose();
    second.dispose();
  });

  it('changes the silhouette for a different deterministic facet seed', () => {
    const first = createIslandGeometry(1717, 3.2, 1.8);
    const second = createIslandGeometry(1718, 3.2, 1.8);
    expect(Array.from(first.getAttribute('position').array)).not.toEqual(
      Array.from(second.getAttribute('position').array),
    );
    first.dispose();
    second.dispose();
  });
});
