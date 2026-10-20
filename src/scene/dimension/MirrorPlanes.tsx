import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Color, CubeTexture, DoubleSide, Matrix3, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import { MIRROR_Y } from './layout';

const VERTEX = /* glsl */`
attribute vec3 bary;
varying vec3 vWorld, vNormalW, vBary;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz; vNormalW = normalize(mat3(modelMatrix) * normal); vBary = bary;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// A pane is a window onto a displaced view of the dimension: the gaseous sky
// is sampled along the reflected ray, rotated by the pane's own displacement,
// so each pane shows a repeated/mirrored region of space. A thin luminous seam
// marks the discontinuity. Panes write depth, so gas in front still covers them.
const FRAGMENT = /* glsl */`
uniform samplerCube uSky;
uniform mat3 uDisplace;
uniform vec3 uSeam;
uniform float uOpacity, uEdge, uFloor;
varying vec3 vWorld, vNormalW, vBary;
void main() {
  vec3 view = normalize(vWorld - cameraPosition);
  vec3 n = normalize(vNormalW);
  vec3 sky = textureCube(uSky, uDisplace * reflect(view, n)).rgb;
  // Soft-compress bright eddies so displaced views never become white sheets.
  sky = sky / (1.0 + sky * 1.2);
  float fres = pow(1.0 - abs(dot(view, n)), 3.0);
  float e = min(vBary.x, min(vBary.y, vBary.z));
  float seam = (1.0 - smoothstep(0.0, uEdge, e)) * (1.0 - uFloor);
  // The floor reflects at reduced, deepened intensity so it never forms a white sheet.
  vec3 col = sky * mix(0.6 + 0.25 * fres, 0.45 + 0.25 * fres, uFloor) * mix(vec3(1.0), vec3(0.7, 0.62, 1.0), uFloor) + uSeam * seam * 2.0;
  float fade = uFloor > 0.5 ? 1.0 - smoothstep(140.0, 330.0, length(vWorld.xz - vec2(0.0, -55.0))) : 1.0;
  gl_FragColor = vec4(col, (uOpacity + seam * 0.4) * fade);
}`;

function createPaneMaterial(displace: Matrix3, opacity: number, floor: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: true, side: DoubleSide,
    uniforms: { uSky: { value: null }, uDisplace: { value: displace }, uSeam: { value: new Color('#ff8fe6') }, uOpacity: { value: opacity }, uEdge: { value: 0.004 }, uFloor: { value: floor ? 1 : 0 } },
  });
}

function triangle(width: number, height: number, random: () => number): BufferGeometry {
  const w = width / 2, h = height / 2;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-w, -h * (0.55 + random() * 0.45), 0, w * (0.55 + random() * 0.45), -h, 0, (random() - 0.5) * w, h, 0]), 3));
  g.setAttribute('bary', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3));
  g.computeVertexNormals();
  return g;
}

/** Pane anchors around the island field's periphery: [position, inward normal]. */
const ANCHORS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-78, 18, -30, 1, 0.1, 0.25], [84, 22, -48, -1, 0.05, 0.3], [-10, 62, -70, 0.1, -1, 0.2], [-60, 8, -120, 0.7, 0.05, 0.6], [70, 5, -130, -0.8, 0.1, 0.5],
];

/** A few large displaced-space panes framing the chamber, plus a reflective
 * floor mirroring the gaseous sky. Restrained: no random glass clutter. */
export function MirrorPlanes({ seed, panes }: { readonly seed: number; readonly panes: number }) {
  const { scene } = useThree();
  const layout = useMemo(() => {
    const random = createSeededRandom(seed ^ 0x7e11);
    return ANCHORS.slice(0, panes).map(([x, y, z, nx, ny, nz], i) => {
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(nx, ny, nz).normalize())
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (random() - 0.5) * 1.2));
      const displace = new Matrix3().setFromMatrix4(new Matrix4().makeRotationY(0.6 + i * 0.9).multiply(new Matrix4().makeRotationX((random() - 0.5) * 0.6)));
      return { position: new Vector3(x, y, z), q, geometry: triangle(70 + random() * 50, 55 + random() * 40, random), material: createPaneMaterial(displace, 0.7, false) };
    });
  }, [seed, panes]);
  // The floor mirrors the sky vertically (y flipped by the reflection itself).
  const floor = useMemo(() => createPaneMaterial(new Matrix3(), 0.9, true), []);
  const floorGeometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-350, -350, 0, 350, -350, 0, 350, 350, 0, -350, -350, 0, 350, 350, 0, -350, 350, 0]), 3));
    g.setAttribute('bary', new BufferAttribute(new Float32Array(18).fill(1), 3));
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => { layout.forEach((p) => { p.geometry.dispose(); p.material.dispose(); }); }, [layout]);
  useEffect(() => () => { floor.dispose(); floorGeometry.dispose(); }, [floor, floorGeometry]);
  useFrame(() => {
    if (!(scene.background instanceof CubeTexture)) return;
    for (const p of layout) p.material.uniforms.uSky!.value = scene.background;
    floor.uniforms.uSky!.value = scene.background;
  });
  return <>
    <mesh name="mirror-floor" geometry={floorGeometry} material={floor} position={[0, MIRROR_Y, -55]} rotation={[-Math.PI / 2, 0, 0]} />
    {layout.map((p, i) => <mesh key={i} name={`mirror-pane-${i}`} geometry={p.geometry} material={p.material} position={p.position} quaternion={p.q} />)}
  </>;
}
