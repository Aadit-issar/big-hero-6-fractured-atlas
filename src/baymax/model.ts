import {
  CapsuleGeometry, Color, CylinderGeometry, Group, LatheGeometry, Material, Mesh, MeshPhysicalMaterial, MeshStandardMaterial,
  Object3D, Quaternion, SphereGeometry, SplineCurve, TorusGeometry, TubeGeometry, Vector2, Vector3, CatmullRomCurve3,
} from 'three';
import type { BufferGeometry } from 'three';
import type { SocketId } from './thrust';

/**
 * Procedural Baymax: the old 1.9 m white body, now ONLY the load-failure fallback of <BaymaxHero>. The shipped avatar is the armoured
 * red GLB (src/baymax/glb.ts, about 2.25 m tall without wing tips, 3.4 m wingspan deployed).
 *
 * Procedural Baymax.
 *
 * Convention: 1 world unit = 1 metre. Origin is the body centre of mass (mid torso). Baymax FACES -Z
 * (three.js camera/forward convention), up is +Y, his right is +X. Feet soles sit at y = -0.80, the crown at y = +1.10
 * (1.90 m tall). The flight pack is on his back (+Z).
 */
export interface ThrusterSocket {
  readonly id: SocketId;
  /** Nozzle exit transform, parented in the body. +Z of this object is the exhaust direction in local space. */
  readonly object: Object3D;
  /** Nominal maximum thrust, newtons. */
  readonly maxThrust: number;
  /** Nozzle exit radius, metres (used to size the plume). */
  readonly nozzleRadius: number;
}

export interface BaymaxRig {
  readonly root: Group;
  /** Child of root that carries the lean/bank/bob pose and every mesh and socket. */
  readonly body: Group;
  readonly sockets: ThrusterSocket[];
  dispose(): void;
}

export type BaymaxLod = 'high' | 'low';

export const BAYMAX_HEIGHT_METRES = 1.9;
export const BAYMAX_ASSET = {
  id: 'baymax-hero',
  version: 'procedural-fallback-1',
  heightMetres: BAYMAX_HEIGHT_METRES,
  forward: [0, 0, -1],
  up: [0, 1, 0],
} as const;

const SOLE_Y = -0.8;

/** Pure layout of the four nozzles (local positions and unit exhaust directions); tested without a renderer. */
export const SOCKET_LAYOUT: Record<SocketId, { position: [number, number, number]; direction: [number, number, number]; maxThrust: number; radius: number }> = (() => {
  const n = Math.hypot(0.714, 0.7);
  const d: [number, number, number] = [0, -0.714 / n, 0.7 / n]; // exhaust: down and aft
  return {
    'pack-left': { position: [-0.135, -0.1, 0.405], direction: [...d], maxThrust: 480, radius: 0.068 },
    'pack-right': { position: [0.135, -0.1, 0.405], direction: [...d], maxThrust: 480, radius: 0.068 },
    'foot-left': { position: [-0.17, SOLE_Y - 0.004, -0.03], direction: [0, -1, 0], maxThrust: 140, radius: 0.05 },
    'foot-right': { position: [0.17, SOLE_Y - 0.004, -0.03], direction: [0, -1, 0], maxThrust: 140, radius: 0.05 },
  };
})();

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);

/** Build a procedural Baymax. All meshes share four+one materials; geometry is owned by the rig and freed by dispose(). */
export function buildBaymax(lod: BaymaxLod = 'high'): BaymaxRig {
  const hi = lod === 'high';
  const seg = hi ? 56 : 24;
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  const g = <T extends BufferGeometry>(geo: T): T => { geos.push(geo); return geo; };

  const vinyl = new MeshPhysicalMaterial({
    color: new Color('#f3f0f2'), roughness: 0.42, metalness: 0, clearcoat: 0.14, clearcoatRoughness: 0.35,
    sheen: 0.55, sheenRoughness: 0.5, sheenColor: new Color('#cdbfff'),
  });
  const eyeMat = new MeshStandardMaterial({ color: new Color('#050507'), roughness: 0.22, metalness: 0.1 });
  const shell = new MeshStandardMaterial({ color: new Color('#4a3f78'), roughness: 0.38, metalness: 0.45 });
  const dark = new MeshStandardMaterial({ color: new Color('#15121f'), roughness: 0.5, metalness: 0.7 });
  const accent = new MeshStandardMaterial({ color: new Color('#b04cff'), emissive: new Color('#8a2bff'), emissiveIntensity: 0.55, roughness: 0.4 });
  mats.push(vinyl, eyeMat, shell, dark, accent);

  const root = new Group();
  root.name = 'baymax';
  const body = new Group();
  body.name = 'baymax-body';
  root.add(body);
  const add = (geo: BufferGeometry, mat: Material, name: string, parent: Object3D = body): Mesh => {
    const m = new Mesh(geo, mat);
    m.name = name;
    parent.add(m);
    return m;
  };

  // Pear torso: lathe of a smooth spline profile (r, y), slightly shallower in depth than width.
  const profile = new SplineCurve([
    new Vector2(0.001, -0.565), new Vector2(0.17, -0.555), new Vector2(0.31, -0.49), new Vector2(0.395, -0.35), new Vector2(0.43, -0.14),
    new Vector2(0.415, 0.08), new Vector2(0.36, 0.28), new Vector2(0.295, 0.46), new Vector2(0.235, 0.6), new Vector2(0.18, 0.69), new Vector2(0.11, 0.74), new Vector2(0.001, 0.76),
  ]).getPoints(hi ? 44 : 18);
  const torso = add(g(new LatheGeometry(profile, seg)), vinyl, 'torso');
  torso.scale.set(1, 1, 0.9);

  // Head: flattened ellipsoid, small relative to the belly.
  const headC = new Vector3(0, 0.9, -0.02);
  const headR = new Vector3(0.235, 0.2, 0.2);
  const head = add(g(new SphereGeometry(1, seg, Math.round(seg * 0.6))), vinyl, 'head');
  head.position.copy(headC);
  head.scale.copy(headR);

  // Face: two black oval eyes on the head surface joined by a thin line.
  const eyeY = 0.915, eyeX = 0.098;
  const surfaceZ = (x: number, y: number): number => {
    const u = (x / headR.x) ** 2 + ((y - headC.y) / headR.y) ** 2;
    return headC.z - headR.z * Math.sqrt(Math.max(0, 1 - u));
  };
  const eyeGeo = g(new SphereGeometry(1, hi ? 24 : 10, hi ? 16 : 8));
  for (const s of [-1, 1] as const) {
    const eye = add(eyeGeo, eyeMat, s < 0 ? 'eye-left' : 'eye-right');
    eye.position.set(s * eyeX, eyeY, surfaceZ(s * eyeX, eyeY) + 0.002);
    eye.scale.set(0.027, 0.034, 0.012);
    // Tilt to hug the curved head.
    eye.rotation.y = s * -0.42;
  }
  const facePts: Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const x = -eyeX + (2 * eyeX * i) / 8;
    facePts.push(new Vector3(x, eyeY, surfaceZ(x, eyeY) + 0.0015));
  }
  add(g(new TubeGeometry(new CatmullRomCurve3(facePts), hi ? 20 : 8, 0.0042, 5, false)), eyeMat, 'face-line');

  // Legs and rounded feet.
  const legGeo = g(new CapsuleGeometry(0.135, 0.1, 6, hi ? 20 : 10));
  const footGeo = g(new SphereGeometry(1, hi ? 32 : 14, hi ? 20 : 8));
  for (const s of [-1, 1] as const) {
    const leg = add(legGeo, vinyl, s < 0 ? 'leg-left' : 'leg-right');
    leg.position.set(s * 0.17, -0.57, -0.01);
    const foot = add(footGeo, vinyl, s < 0 ? 'foot-left-shell' : 'foot-right-shell');
    foot.position.set(s * 0.17, SOLE_Y + 0.085, -0.04);
    foot.scale.set(0.145, 0.085, 0.2);
  }

  // Stubby arms angled out and down, with rounded mitten hands.
  const armGeo = g(new CapsuleGeometry(0.112, 0.28, 6, hi ? 20 : 10));
  const handGeo = g(new SphereGeometry(1, hi ? 28 : 12, hi ? 18 : 8));
  const shoulderGeo = g(new SphereGeometry(0.108, hi ? 24 : 10, hi ? 16 : 8));
  const q = new Quaternion();
  for (const s of [-1, 1] as const) {
    const sh = new Vector3(s * 0.31, 0.4, 0.0);
    const dir = new Vector3(s * Math.sin(0.62), -Math.cos(0.62), 0.04).normalize();
    const shoulder = add(shoulderGeo, vinyl, s < 0 ? 'shoulder-left' : 'shoulder-right');
    shoulder.position.copy(sh);
    const arm = add(armGeo, vinyl, s < 0 ? 'arm-left' : 'arm-right');
    arm.position.copy(sh).addScaledVector(dir, 0.25);
    arm.quaternion.copy(q.setFromUnitVectors(Y_AXIS, dir));
    const hand = add(handGeo, vinyl, s < 0 ? 'hand-left' : 'hand-right');
    hand.position.copy(sh).addScaledVector(dir, 0.5);
    hand.scale.set(0.115, 0.135, 0.105);
    hand.quaternion.copy(q.setFromUnitVectors(Y_AXIS, dir));
  }

  // Compact slim thruster pack on the back.
  const pack = add(g(new CapsuleGeometry(0.12, 0.26, 6, hi ? 20 : 10)), shell, 'pack');
  pack.position.set(0, 0.2, 0.335);
  pack.scale.set(1.9, 1, 0.72);
  const strip = add(g(new TorusGeometry(0.2, 0.006, 6, hi ? 40 : 16)), accent, 'pack-strip');
  strip.position.set(0, 0.2, 0.335);
  strip.rotation.x = Math.PI / 2; // horizontal band around the pack waist
  strip.scale.set(1.16, 0.5, 1);
  const strap = add(g(new CapsuleGeometry(0.016, 0.2, 4, 8)), dark, 'pack-spine');
  strap.position.set(0, 0.2, 0.418);

  // Nozzles and sockets.
  const housing = g(new CylinderGeometry(0.052, 0.078, 0.15, hi ? 24 : 12, 1, false));
  const lip = g(new TorusGeometry(0.074, 0.01, 6, hi ? 24 : 12));
  const footHousing = g(new CylinderGeometry(0.058, 0.062, 0.016, hi ? 24 : 12));
  const sockets: ThrusterSocket[] = [];
  const dirV = new Vector3();
  for (const id of ['pack-left', 'pack-right', 'foot-left', 'foot-right'] as const) {
    const L = SOCKET_LAYOUT[id];
    const object = new Object3D();
    object.name = `socket-${id}`;
    object.position.set(...L.position);
    dirV.set(...L.direction);
    object.quaternion.copy(q.setFromUnitVectors(Z_AXIS, dirV));
    body.add(object);
    if (id.startsWith('pack')) {
      const h = add(housing, dark, `nozzle-${id}`);
      // Housing axis (Y) points along the exhaust; its centre sits just upstream of the exit plane.
      h.quaternion.copy(q.setFromUnitVectors(Y_AXIS, dirV));
      h.position.set(...L.position).addScaledVector(dirV, -0.07);
      const l = add(lip, accent, `nozzle-lip-${id}`);
      l.position.set(...L.position).addScaledVector(dirV, -0.004);
      l.quaternion.copy(q.setFromUnitVectors(Z_AXIS, dirV));
    } else {
      const h = add(footHousing, dark, `nozzle-${id}`);
      h.position.set(L.position[0], SOLE_Y + 0.002, L.position[2]);
    }
    sockets.push({ id, object, maxThrust: L.maxThrust, nozzleRadius: L.radius });
  }

  return {
    root, body, sockets,
    dispose() {
      for (const geo of geos) geo.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
