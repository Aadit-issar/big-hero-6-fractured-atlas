import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import {
  BackSide, BufferAttribute, BufferGeometry, CubeCamera, HalfFloatType, LinearMipmapLinearFilter, Mesh, PMREMGenerator,
  Scene, ShaderMaterial, SphereGeometry, Vector3, WebGLCubeRenderTarget,
} from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import { updateReadiness } from '../../rendering/renderReadiness';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';

/** Direction toward the key light; shared by the sky glow, clouds and lighting. */
export const SUN_DIRECTION = new Vector3(111, 72, -191).normalize();
/** Bright nebula core placed behind the opening composition. */
export const NEBULA_FOCUS = SUN_DIRECTION;

const SKY_VERTEX = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Static, seed-offset procedural sky: domain-warped nebula, dust lanes, a
// galactic band, three star layers and a key-light glow. Linear HDR output;
// tone mapping happens when the baked cubemap is displayed.
const SKY_FRAGMENT = /* glsl */`
uniform vec3 uSunDir, uFocus, uOffset;
uniform float uPixel;
varying vec3 vDir;
float h13(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
vec3 h33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
vec4 h43(vec3 p) { vec4 q = fract(vec4(p.xyzx) * vec4(0.1031, 0.1030, 0.0973, 0.1099)); q += dot(q, q.wzxy + 33.33); return fract((q.xxyz + q.yzzw) * q.zywx); }
// Four independent value-noise channels per lattice lookup. Two vector fBm
// passes replace seven scalar ones: ANGLE/FXC inlines every loop, so this
// keeps compile and bake time low.
vec4 vnoise4(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h43(i), h43(i + vec3(1,0,0)), f.x), mix(h43(i + vec3(0,1,0)), h43(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h43(i + vec3(0,0,1)), h43(i + vec3(1,0,1)), f.x), mix(h43(i + vec3(0,1,1)), h43(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec4 fbm4(vec3 p) { vec4 s = vec4(0.0); float a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise4(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float starLayer(vec3 d, float scale, float density, float size) {
  vec3 p = d * scale; vec3 c = floor(p);
  vec3 r = h33(c);
  if (r.x > density) return 0.0;
  vec3 star = c + 0.3 + 0.4 * h33(c + 7.7);
  float dist = length(p - star) / (uPixel * scale * size);
  return exp(-dist * dist) * pow(r.y, 6.0) * (0.6 + 2.4 * r.z);
}
// Spiral twist about direction c: strong near c, fading with angular distance.
vec3 twist(vec3 d, vec3 c, float strength, float reach) {
  float cs = dot(d, c), ang = acos(clamp(cs, -1.0, 1.0));
  float sw = strength * exp(-ang / reach);
  return d * cos(sw) + cross(c, d) * sin(sw) + c * cs * (1.0 - cos(sw));
}
void main() {
  vec3 d = normalize(vDir);
  // One dominant whirlpool toward the vortex plus three secondary eddies:
  // the whole sky is billowing gas, never empty space.
  vec3 e1 = normalize(vec3(-0.7, 0.35, -0.6)), e2 = normalize(vec3(0.2, -0.45, 0.85)), e3 = normalize(vec3(-0.5, -0.2, 0.8));
  vec3 dd = twist(d, uFocus, 2.0, 0.22);
  dd = twist(dd, e1, 1.8, 0.14);
  dd = twist(dd, e2, 1.5, 0.12);
  dd = twist(dd, e3, 1.3, 0.11);
  vec3 q = dd * 2.2 + uOffset;
  vec4 warp = fbm4(q);
  vec4 n = fbm4(q * 1.8 + warp.xyz * 2.1);
  float billow = smoothstep(0.42, 0.72, n.x * 0.75 + warp.w * 0.35);
  // Light-facing crests from a shifted sample along the vortex direction.
  float crest = smoothstep(0.45, 0.85, n.y * 0.6 + billow * 0.5);
  vec3 indigo = vec3(0.012, 0.008, 0.06), cobalt = vec3(0.02, 0.05, 0.3), violet = vec3(0.16, 0.04, 0.38), magenta = vec3(0.75, 0.09, 0.5), peach = vec3(0.95, 0.42, 0.4);
  vec3 deep = mix(indigo, cobalt, smoothstep(0.3, 0.75, n.w));
  vec3 body = mix(cobalt, violet, smoothstep(0.35, 0.7, n.z));
  vec3 col = mix(deep, body, billow);
  col += mix(magenta, peach, crest * crest) * crest * crest * billow * 0.8;
  // Warm cores in each eddy; the main one is brightest but keeps colour.
  float c0 = max(dot(d, uFocus), 0.0);
  col += vec3(1.0, 0.62, 0.55) * (pow(c0, 60.0) * 1.0 + pow(c0, 12.0) * 0.12);
  col += vec3(1.0, 0.5, 0.75) * (pow(max(dot(d, e1), 0.0), 90.0) * 0.8 + pow(max(dot(d, e2), 0.0), 110.0) * 0.6 + pow(max(dot(d, e3), 0.0), 130.0) * 0.5);
  float stars = starLayer(d, 210.0, 0.004, 1.0) * 0.5;
  col += vec3(0.95, 0.85, 1.0) * stars * (1.0 - billow);
  gl_FragColor = vec4(col, 1.0);
}
`;

function createStarGeometry(seed: number, count: number): BufferGeometry {
  const random = createSeededRandom(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const z = random() * 2 - 1, a = random() * Math.PI * 2, r = 1800, h = Math.sqrt(1 - z * z);
    positions.set([r * h * Math.cos(a), r * z, r * h * Math.sin(a)], i * 3);
    const warm = random(), b = 0.45 + random() * 0.55;
    colors.set([b * (0.78 + warm * 0.22), b * (0.86 + warm * 0.06), b * (1 - warm * 0.22)], i * 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

export function CosmicSky({ seed, size, atmosphere }: { readonly seed: number; readonly size: number; readonly atmosphere: AtmosphereUniforms }) {
  const { gl, scene } = useThree();
  const stars = useMemo(() => createStarGeometry(seed ^ 0x2c9277b5, 40), [seed]);

  useEffect(() => {
    const random = createSeededRandom(seed ^ 0x51ed270b);
    const offset = new Vector3(random() * 40, random() * 40, random() * 40);
    let disposeBake: (() => void) | null = null;
    // Deferred one task so terrain worker jobs are posted before the GPU bake.
    const timer = window.setTimeout(() => {
      const started = performance.now();
      const skyScene = new Scene();
      const material = new ShaderMaterial({
        vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: BackSide, depthWrite: false,
        uniforms: { uSunDir: { value: SUN_DIRECTION }, uFocus: { value: NEBULA_FOCUS }, uPixel: { value: (Math.PI / 2) / size }, uOffset: { value: offset } },
      });
      const sphere = new Mesh(new SphereGeometry(5, 64, 32), material);
      skyScene.add(sphere);
      const target = new WebGLCubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter });
      new CubeCamera(0.1, 10, target).update(gl, skyScene);
      const pmrem = new PMREMGenerator(gl);
      const environment = pmrem.fromCubemap(target.texture);
      scene.background = target.texture;
      scene.environment = environment.texture;
      scene.environmentIntensity = 1.3;
      atmosphere.uSkyHaze.value = target.texture;
      // Sample a ~16 px mip so haze colour is a smooth blur of the nebula.
      atmosphere.uHazeMip.value = Math.max(0, Math.log2(size) - 4);
      material.dispose(); sphere.geometry.dispose(); pmrem.dispose();
      updateReadiness({ skyReady: true, skyMilliseconds: performance.now() - started });
      disposeBake = () => { environment.dispose(); target.dispose(); };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      scene.background = null; scene.environment = null; atmosphere.uSkyHaze.value = null;
      disposeBake?.();
      updateReadiness({ skyReady: false });
    };
  }, [gl, scene, seed, size, atmosphere]);
  useEffect(() => () => stars.dispose(), [stars]);

  return (
    <points geometry={stars} frustumCulled={false} renderOrder={-1}>
      <pointsMaterial vertexColors size={2.2} sizeAttenuation={false} transparent opacity={0.9} depthWrite={false} fog={false} />
    </points>
  );
}
