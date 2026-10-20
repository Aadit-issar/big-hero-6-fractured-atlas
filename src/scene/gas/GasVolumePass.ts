import { Data3DTexture, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix4, RepeatWrapping, RGFormat, ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget } from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export const MAX_ISLANDS = 14;
export const MAX_FOLDS = 8;
export const MAX_HAZARDS = 4;

const VERTEX = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Raymarched dimensional gas. Density = baked tileable Perlin–Worley noise,
 * domain-warped, twisted into a whirlpool around the vortex axis, folded into a
 * mirrored corridor, and carved by simulation state: clearings around the live
 * island transforms, passages around open fold endpoints, extra turbulence and
 * brightness at sampled hazard points. Self-luminous emission (no shadow rays)
 * plus a one-tap directional gradient for light-facing crests. */
const MARCH = /* glsl */`
precision highp float;
precision highp sampler3D;
#include <packing>
uniform sampler2D tDepth;
uniform sampler3D uNoise;
uniform float cameraNear, cameraFar, uTime, uCoverage, uSigma, uScale, uMaxDistance, uJitter, uPixelAngle;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos, uVortex, uAxis, uLight, uFieldCentre;
uniform vec4 uIslands[${MAX_ISLANDS}];
uniform vec4 uFolds[${MAX_FOLDS}];
uniform vec4 uHazards[${MAX_HAZARDS}];
varying vec2 vUv;

// Unstructured per-pixel dither (IGN's diagonal pattern showed through the
// half-resolution upsample); the composite tent filter blends it into grain.
float dither(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Returns density; writes colour-shaping terms.
float gas(vec3 p, float t, out float shade, out float crest, out float energy, out float passage) {
  vec3 rel = p - uVortex;
  float along = dot(rel, uAxis);
  vec3 radial = rel - uAxis * along;
  float rr = length(radial);
  // Whirlpool: stronger twist near the vortex axis, slow model-time rotation.
  float ang = 2.1 * exp(-rr / 80.0) * exp(-abs(along) / 260.0) + uTime * 0.035 * exp(-length(rel) / 260.0);
  vec3 q = uVortex + uAxis * along + radial * cos(ang) + cross(uAxis, radial) * sin(ang);
  // Region B: the entrance corridor folds onto itself (mirrored cloud walls).
  float corridor = smoothstep(26.0, 46.0, q.z);
  q.x = mix(q.x, -3.0 + abs(q.x + 3.0) * 1.0, corridor);
  q.y = mix(q.y, 9.0 + abs(q.y - 9.0), corridor * 0.7);
  q += vec3(0.25, 0.05, 0.9) * uTime;

  // Region C: hazard-driven turbulence (sampled simulation instability).
  float turb = 0.0;
  energy = 0.0;
  passage = 0.0;
  for (int i = 0; i < ${MAX_HAZARDS}; i++) {
    float d = length(p - uHazards[i].xyz);
    float k = uHazards[i].w * exp(-d * d / 2600.0);
    turb += k; energy += k * 0.6;
  }
  vec3 tq = q * uScale;
  // Explicit LOD from ray distance: one march sample spans this many texels.
  // (Implicit derivatives are undefined inside the divergent march loop.)
  float footprint = max(t, 1.0) * uPixelAngle * 128.0 * uScale;
  float lodBig = log2(max(1.0, footprint * 0.42)), lodDetail = log2(max(1.0, footprint * 1.55));
  vec2 big = textureLod(uNoise, tq * 0.42, lodBig).rg;
  shade = big.g; crest = 0.0;
  // Early out: even full detail cannot lift this sample over the coverage threshold.
  if (big.r * 0.58 + 0.42 < uCoverage) return 0.0;
  vec3 wq = tq * 1.55 + (big.g - 0.5) * (0.35 + turb * 0.9) * vec3(1.0, 0.55, 1.25) + vec3(0.0, uTime * 0.0015, 0.0);
  float detail = textureLod(uNoise, wq, lodDetail).r;
  float shape = big.r * 0.58 + detail * 0.42;
  float dens = smoothstep(uCoverage, uCoverage + 0.13, shape);
  if (dens <= 0.0) return 0.0;

  // Carve: camera bubble, islands (live transforms), open folds, vortex cavity.
  dens *= smoothstep(8.0, 36.0, length(p - uCamPos));
  for (int i = 0; i < ${MAX_ISLANDS}; i++) {
    float d = length(p - uIslands[i].xyz);
    dens *= smoothstep(uIslands[i].w + 2.0, uIslands[i].w + 20.0, d);
  }
  for (int i = 0; i < ${MAX_FOLDS}; i++) {
    float d = length(p - uFolds[i].xyz);
    // Region D: real open connections part the gas into a passage rimmed with light.
    dens *= mix(1.0, smoothstep(7.0, 30.0, d), uFolds[i].w);
    passage += uFolds[i].w * exp(-pow((d - 26.0) / 8.0, 2.0));
  }
  vec3 seg = uVortex - uFieldCentre;
  float h = clamp(dot(p - uFieldCentre, seg) / dot(seg, seg), 0.0, 1.0);
  float cavity = length(p - uFieldCentre - seg * h);
  dens *= mix(0.12, 1.0, smoothstep(18.0, 70.0 + h * 40.0, cavity));
  // Light-facing crest (only for visible samples): density falls toward the light.
  if (dens > 0.002) {
    float shifted = textureLod(uNoise, wq + uLight * 0.03, lodDetail).r * 0.42 + big.r * 0.58;
    crest = smoothstep(0.35, 0.95, 0.5 + (shape - shifted) * 7.0);
  }
  return dens;
}

void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 view = uProjInv * ndc; view /= view.w;
  vec3 dirView = normalize(view.xyz);
  vec3 dir = normalize((uCamWorld * vec4(dirView, 0.0)).xyz);
  float depth = texture(tDepth, vUv).x;
  float sceneT = depth >= 1.0 ? 1e9 : (-perspectiveDepthToViewZ(depth, cameraNear, cameraFar)) / max(1e-4, -dirView.z);
  float tEnd = min(sceneT, uMaxDistance);
  float jitter = dither(gl_FragCoord.xy + uJitter);
  vec3 col = vec3(0.0);
  float T = 1.0;
  // Saturated, deliberately low-energy emission: richness over brightness.
  vec3 indigo = vec3(0.02, 0.012, 0.11), cobalt = vec3(0.025, 0.07, 0.48), violet = vec3(0.26, 0.035, 0.58), magenta = vec3(0.6, 0.03, 0.46), pink = vec3(0.85, 0.16, 0.6), warm = vec3(0.9, 0.42, 0.3);
  for (int i = 0; i < STEPS; i++) {
    float f0 = (float(i) + jitter) / float(STEPS), f1 = (float(i) + 1.0 + jitter) / float(STEPS);
    float t = tEnd * f0 * f0, dt = tEnd * (f1 * f1 - f0 * f0);
    vec3 p = uCamPos + dir * t;
    float shade, crest, energy, passage;
    float d = gas(p, t, shade, crest, energy, passage);
    if (d > 0.002) {
      float vortexGlow = exp(-length(p - uVortex) / 110.0);
      vec3 body = mix(mix(indigo, cobalt, smoothstep(0.2, 0.5, shade)), violet, smoothstep(0.5, 0.75, shade));
      // Peach/warm only near the vortex; elsewhere crests stay magenta to pink.
      vec3 lit = mix(mix(violet, magenta, crest), pink, crest * crest * crest);
      lit = mix(lit, warm, vortexGlow * crest);
      float edge = d * (1.0 - d) * 4.0;
      // Dark bodies, luminous light-facing crests and rims: contrast carries volume.
      // Simulation energy (hazard, open folds) brightens crests, never flat fog.
      float glowK = crest * (1.0 + energy * 2.5);
      vec3 emit = body * (0.28 + 0.3 * d) + lit * glowK * (0.42 + 0.8 * edge) + warm * vortexGlow * (0.15 + 0.35 * crest)
        + vec3(0.42, 0.55, 1.0) * passage * (0.1 + 0.4 * crest);
      float a = 1.0 - exp(-d * uSigma * dt);
      col += T * a * emit;
      T *= 1.0 - a;
      if (T < 0.015) break;
    }
  }
  gl_FragColor = vec4(col, T);
}`;

const COMPOSITE = /* glsl */`
uniform sampler2D tScene, tGas;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 scene = texture2D(tScene, vUv);
  // Small tent filter while upsampling hides the march dither.
  vec4 gas = texture2D(tGas, vUv) * 0.28 + (texture2D(tGas, vUv + uTexel * vec2(1.0, 1.0)) + texture2D(tGas, vUv + uTexel * vec2(-1.0, 1.0))
    + texture2D(tGas, vUv + uTexel * vec2(1.0, -1.0)) + texture2D(tGas, vUv + uTexel * vec2(-1.0, -1.0))) * 0.18;
  vec3 c = scene.rgb * gas.a + gas.rgb;
  // Linear-light saturation lift toward the references' vivid violet/magenta
  // (before bloom and the single Neutral tone-mapping transform).
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(0.0), vec3(luma) + (c - vec3(luma)) * 1.45);
  gl_FragColor = vec4(c, 1.0);
}`;

export interface GasSettings { readonly resolutionScale: number; readonly steps: number }

export class GasVolumePass extends Pass {
  readonly march: ShaderMaterial;
  private readonly composite: ShaderMaterial;
  private readonly target: WebGLRenderTarget;
  private readonly quad = new FullScreenQuad();
  private readonly scale: number;

  constructor(private readonly camera: PerspectiveCamera, noise: Data3DTexture, settings: GasSettings) {
    super();
    this.scale = settings.resolutionScale;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.march = new ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: MARCH, depthTest: false, depthWrite: false,
      defines: { STEPS: settings.steps },
      uniforms: {
        tDepth: { value: null }, uNoise: { value: noise }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
        uTime: { value: 0 }, uCoverage: { value: 0.54 }, uSigma: { value: 0.1 }, uScale: { value: 1 / 150 }, uMaxDistance: { value: 380 }, uJitter: { value: 0 }, uPixelAngle: { value: 0.002 },
        uProjInv: { value: new Matrix4() }, uCamWorld: { value: new Matrix4() }, uCamPos: { value: new Vector3() },
        uVortex: { value: new Vector3() }, uAxis: { value: new Vector3(0, 0, -1) }, uLight: { value: new Vector3(0, 1, 0) }, uFieldCentre: { value: new Vector3() },
        uIslands: { value: Array.from({ length: MAX_ISLANDS }, () => new Vector4(0, -1e5, 0, 0)) },
        uFolds: { value: Array.from({ length: MAX_FOLDS }, () => new Vector4(0, -1e5, 0, 0)) },
        uHazards: { value: Array.from({ length: MAX_HAZARDS }, () => new Vector4(0, -1e5, 0, 0)) },
      },
    });
    this.composite = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false, uniforms: { tScene: { value: null }, tGas: { value: null }, uTexel: { value: new Vector2(1, 1) } } });
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width * this.scale)), h = Math.max(1, Math.floor(height * this.scale));
    this.target.setSize(w, h);
    (this.composite.uniforms.uTexel!.value as Vector2).set(1.4 / w, 1.4 / h);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.march.uniforms;
    u.tDepth!.value = readBuffer.depthTexture;
    u.cameraNear!.value = this.camera.near; u.cameraFar!.value = this.camera.far;
    u.uPixelAngle!.value = 2 * Math.tan((this.camera.fov * Math.PI) / 360) / Math.max(1, this.target.height);
    (u.uProjInv!.value as Matrix4).copy(this.camera.projectionMatrixInverse);
    (u.uCamWorld!.value as Matrix4).copy(this.camera.matrixWorld);
    (u.uCamPos!.value as Vector3).setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.target);
    this.quad.material = this.march;
    this.quad.render(renderer);
    this.composite.uniforms.tScene!.value = readBuffer.texture;
    this.composite.uniforms.tGas!.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.composite;
    this.quad.render(renderer);
  }

  dispose(): void { this.target.dispose(); this.march.dispose(); this.composite.dispose(); this.quad.dispose(); }
}

export function createGasTexture(data: Uint8Array, size: number): Data3DTexture {
  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGFormat; texture.type = UnsignedByteType;
  texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter; texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

