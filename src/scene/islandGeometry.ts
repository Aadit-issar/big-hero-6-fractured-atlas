import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createSeededRandom } from '../simulation/seededRandom';

type Point3 = readonly [number, number, number];

function addTriangle(target: number[], a: Point3, b: Point3, c: Point3, topFacing: boolean): void {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acz = c[2] - a[2];
  const normalY = abz * acx - abx * acz;
  const shouldReverse = topFacing ? normalY < 0 : normalY > 0;
  const second = shouldReverse ? c : b;
  const third = shouldReverse ? b : c;
  target.push(...a, ...second, ...third);
}

/** Build an irregular plateau with a tapered, fractured-looking underside. */
export function createIslandGeometry(seed: number, radius: number, height: number): BufferGeometry {
  const random = createSeededRandom(seed);
  const segments = 18 + Math.floor(random() * 7);
  const top: number[] = [];
  const underside: number[] = [];
  const angles = new Array<number>(segments);
  const outline = new Array<number>(segments);
  const ridge = new Array<number>(segments);

  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    angles[index] = angle;
    outline[index] = 0.84
      + 0.09 * Math.sin(angle * 3 + random() * 0.5)
      + 0.05 * Math.sin(angle * 5 + random() * 0.4)
      + random() * 0.08;
    ridge[index] = (random() - 0.5) * height * 0.18;
  }

  const topRings: Point3[][] = [];
  for (const fraction of [0.24, 0.52, 0.79, 1]) {
    topRings.push(angles.map((angle, index) => {
      const localRadius = radius * fraction * outline[index]!;
      const topY = height * (0.12 + 0.12 * (1 - fraction)) + ridge[index]!;
      return [Math.cos(angle) * localRadius, topY, Math.sin(angle) * localRadius] as const;
    }));
  }

  const center: Point3 = [0, height * 0.28, 0];
  for (let index = 0; index < segments; index += 1) {
    addTriangle(top, center, topRings[0]![index]!, topRings[0]![(index + 1) % segments]!, true);
  }

  for (let ring = 0; ring < topRings.length - 1; ring += 1) {
    const inner = topRings[ring]!;
    const outer = topRings[ring + 1]!;
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      addTriangle(top, inner[index]!, outer[index]!, outer[next]!, true);
      addTriangle(top, inner[index]!, outer[next]!, inner[next]!, true);
    }
  }

  const depth = radius * 0.43 + height * 0.55;
  const sideRings: Point3[][] = [topRings[topRings.length - 1]!];
  for (const [fraction, depthFraction] of [[0.78, 0.32], [0.53, 0.7], [0.23, 1.04]] as const) {
    sideRings.push(angles.map((angle, index) => {
      const localRadius = radius * fraction * (0.88 + random() * 0.14);
      const angularOffset = (random() - 0.5) * 0.055;
      return [
        Math.cos(angle + angularOffset) * localRadius,
        -depth * depthFraction + ridge[index]! * 0.28,
        Math.sin(angle + angularOffset) * localRadius,
      ] as const;
    }));
  }

  for (let ring = 0; ring < sideRings.length - 1; ring += 1) {
    const upper = sideRings[ring]!;
    const lower = sideRings[ring + 1]!;
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      addTriangle(underside, upper[index]!, lower[index]!, lower[next]!, false);
      addTriangle(underside, upper[index]!, lower[next]!, upper[next]!, false);
    }
  }

  const bottomPoint: Point3 = [0, -depth * 1.28, 0];
  const lastRing = sideRings[sideRings.length - 1]!;
  for (let index = 0; index < segments; index += 1) {
    addTriangle(underside, lastRing[index]!, bottomPoint, lastRing[(index + 1) % segments]!, false);
  }

  const geometry = new BufferGeometry();
  const positions = [...top, ...underside];
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.addGroup(0, top.length / 3, 0);
  geometry.addGroup(top.length / 3, underside.length / 3, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
