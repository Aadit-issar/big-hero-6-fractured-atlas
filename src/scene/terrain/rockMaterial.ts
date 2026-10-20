import { Color, CubeTexture, DataTexture, MeshStandardMaterial, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, Texture, TextureLoader, Vector4 } from 'three';
import type { WebGLRenderer } from 'three';

/** Three CC0 Poly Haven PBR sets (see docs/ASSET_PROVENANCE.md). */
const BASE = `${import.meta.env.BASE_URL}assets/textures/`;
const SETS = {
  cliff: { albedo: 'cliff_side/cliff_side_diff_2k.jpg', normal: 'cliff_side/cliff_side_nor_gl_2k.jpg', arm: 'cliff_side/cliff_side_arm_2k.jpg' },
  top: { albedo: 'rocks_ground_06/rocks_ground_06_diff_1k.jpg', normal: 'rocks_ground_06/rocks_ground_06_nor_gl_1k.jpg', arm: 'rocks_ground_06/rocks_ground_06_arm_1k.jpg' },
  base: { albedo: 'lichen_rock/lichen_rock_diff_1k.jpg', normal: 'lichen_rock/lichen_rock_nor_gl_1k.jpg', arm: 'lichen_rock/lichen_rock_arm_1k.jpg' },
} as const;
type LayerName = keyof typeof SETS;
type MapName = 'albedo' | 'normal' | 'arm';

function flatTexture(rgba: [number, number, number, number], srgb: boolean): Texture {
  const texture = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat);
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export interface RockTextureSet {
  readonly maps: Record<LayerName, Record<MapName, Texture>>;
  /** Resolves when every map has loaded or fallen back. */
  readonly ready: Promise<{ readonly failed: boolean }>;
  dispose(): void;
}

/** Loads every map once. Missing files resolve to neutral 1×1 maps so the
 * scene keeps rendering (procedural shading only) instead of crashing. */
export function loadRockTextures(renderer: WebGLRenderer, anisotropy: number): RockTextureSet {
  const loader = new TextureLoader();
  const maps = {} as Record<LayerName, Record<MapName, Texture>>;
  const all: Texture[] = [];
  let remaining = 0, failed = false;
  let resolveReady: (value: { failed: boolean }) => void = () => undefined;
  const ready = new Promise<{ failed: boolean }>((resolve) => { resolveReady = resolve; });
  const settle = () => { remaining -= 1; if (remaining === 0) resolveReady({ failed }); };
  const maxAniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  for (const layer of Object.keys(SETS) as LayerName[]) {
    maps[layer] = {} as Record<MapName, Texture>;
    for (const map of ['albedo', 'normal', 'arm'] as const) {
      const fallback = map === 'albedo' ? flatTexture([118, 118, 122, 255], true) : map === 'normal' ? flatTexture([128, 128, 255, 255], false) : flatTexture([255, 220, 0, 255], false);
      remaining += 1;
      const texture = loader.load(BASE + SETS[layer][map], () => settle(), undefined, () => {
        failed = true;
        // Copy the neutral fallback image into the shared texture object in place.
        texture.image = fallback.image as unknown as HTMLImageElement; texture.needsUpdate = true; settle();
      });
      texture.colorSpace = map === 'albedo' ? SRGBColorSpace : NoColorSpace;
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.anisotropy = maxAniso;
      maps[layer][map] = texture;
      all.push(texture, fallback);
    }
  }
  return { maps, ready, dispose: () => all.forEach((t) => t.dispose()) };
}

export interface AtmosphereUniforms {
  readonly uSkyHaze: { value: CubeTexture | Texture | null };
  readonly uHazeDensity: { value: number };
  readonly uHazeFloor: { value: number };
  readonly uHazeTint: { value: Color };
  readonly uHazeMip: { value: number };
}

/** Shared aerial-perspective state: distant rock fades toward the blurred sky
 * radiance in the same direction, so silhouettes sink into the nebula. */
export function createAtmosphereUniforms(): AtmosphereUniforms {
  return {
    uSkyHaze: { value: null }, uHazeDensity: { value: 0.0075 }, uHazeFloor: { value: -22 },
    uHazeTint: { value: new Color(0.72, 0.68, 0.8) }, uHazeMip: { value: 5 },
  };
}

export interface RockMaterialOptions {
  readonly textures: RockTextureSet;
  readonly atmosphere: AtmosphereUniforms;
  /** Multiplies haze density; distant scenery uses < 1 so it stays visible. */
  readonly hazeScale?: number;
  /** Texture scale per world unit: [cliff, top, base, macro]. */
  readonly scales?: Vector4;
  readonly cliffTint?: Color;
  readonly mineral?: boolean;
  /** Fresnel edge glow (magenta to cobalt), the mirror dimension's luminous rims. */
  readonly rim?: number;
  /** Cavern-wall mode: turbulent emissive dimensional matter and torn holes. */
  readonly storm?: boolean;
}

export interface RockMaterial extends MeshStandardMaterial {
  readonly userData: { mineralColor: { value: Color }; mineralIntensity: { value: number } };
}

const VERTEX_PARS = /* glsl */`
attribute vec4 terrain;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec4 vTerrain;
varying vec3 vAtmoWorld;
`;

const FRAGMENT_PARS = /* glsl */`
uniform sampler2D tCliffA, tCliffN, tCliffR, tTopA, tTopN, tTopR, tBaseA, tBaseN, tBaseR;
uniform vec4 uScales;
uniform vec3 uCliffTint, uTopTint, uBaseTint, uMineralColor;
uniform float uMineral, uHazeDensity, uHazeFloor, uHazeScale, uHazeMip;
uniform vec3 uHazeTint;
uniform samplerCube uSkyHaze;
uniform mat3 normalMatrix;
uniform float uRimStrength, uStormIntensity;
uniform vec3 uRimA, uRimB, uStormA, uStormB, uStormC;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec4 vTerrain;
varying vec3 vAtmoWorld;

float rockHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rockNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rockHash(i), rockHash(i + vec3(1,0,0)), f.x), mix(rockHash(i + vec3(0,1,0)), rockHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rockHash(i + vec3(0,0,1)), rockHash(i + vec3(1,0,1)), f.x), mix(rockHash(i + vec3(0,1,1)), rockHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

struct RockSample { vec3 albedo; vec3 normal; vec3 arm; };

// Triplanar PBR sampling with whiteout normal blending in object space.
// Explicit gradients keep mip selection valid inside weight branches.
RockSample triplanar(sampler2D A, sampler2D N, sampler2D R, vec3 p, vec3 n, vec3 w, float scale, vec3 dpdx, vec3 dpdy) {
  RockSample s; s.albedo = vec3(0.0); s.arm = vec3(0.0);
  vec3 tx = vec3(0.0), ty = vec3(0.0), tz = vec3(0.0);
  if (w.x > 0.01) {
    vec2 uv = p.zy * scale; vec2 gx = dpdx.zy * scale, gy = dpdy.zy * scale;
    s.albedo += textureGrad(A, uv, gx, gy).rgb * w.x; s.arm += textureGrad(R, uv, gx, gy).rgb * w.x;
    vec3 t = textureGrad(N, uv, gx, gy).xyz * 2.0 - 1.0; tx = vec3(t.xy + n.zy, abs(t.z) * n.x);
  }
  if (w.y > 0.01) {
    vec2 uv = p.xz * scale; vec2 gx = dpdx.xz * scale, gy = dpdy.xz * scale;
    s.albedo += textureGrad(A, uv, gx, gy).rgb * w.y; s.arm += textureGrad(R, uv, gx, gy).rgb * w.y;
    vec3 t = textureGrad(N, uv, gx, gy).xyz * 2.0 - 1.0; ty = vec3(t.xy + n.xz, abs(t.z) * n.y);
  }
  if (w.z > 0.01) {
    vec2 uv = p.xy * scale; vec2 gx = dpdx.xy * scale, gy = dpdy.xy * scale;
    s.albedo += textureGrad(A, uv, gx, gy).rgb * w.z; s.arm += textureGrad(R, uv, gx, gy).rgb * w.z;
    vec3 t = textureGrad(N, uv, gx, gy).xyz * 2.0 - 1.0; tz = vec3(t.xy + n.xy, abs(t.z) * n.z);
  }
  s.normal = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z + n * 1e-4);
  return s;
}

// Planar (top-down) sampling for upward-facing ground layers.
RockSample planarTop(sampler2D A, sampler2D N, sampler2D R, vec3 p, vec3 n, float scale, vec3 dpdx, vec3 dpdy) {
  RockSample s;
  vec2 uv = p.xz * scale; vec2 gx = dpdx.xz * scale, gy = dpdy.xz * scale;
  s.albedo = textureGrad(A, uv, gx, gy).rgb; s.arm = textureGrad(R, uv, gx, gy).rgb;
  vec3 t = textureGrad(N, uv, gx, gy).xyz * 2.0 - 1.0;
  vec3 b = vec3(t.xy + n.xz, abs(t.z) * n.y);
  s.normal = normalize(b.xzy);
  return s;
}

// Desaturate the photographed albedo toward a geological tint while keeping
// its luminance structure (orange sandstone becomes basalt/slate).
vec3 recolor(vec3 albedo, vec3 tint, float keep) {
  float l = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l) * tint, albedo * tint, keep);
}
`;

/** MeshStandardMaterial extended with triplanar geological layering, cavity AO,
 * field-driven mineral emission and sky-coloured aerial perspective. Lighting,
 * shadows, tone mapping and the PBR BRDF remain three.js' own. */
export function createRockMaterial({ textures, atmosphere, hazeScale = 1, scales = new Vector4(0.16, 0.34, 0.24, 0.08), cliffTint = new Color('#a59fc4'), mineral = true, rim = 1, storm = false }: RockMaterialOptions): RockMaterial {
  const material = new MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }) as RockMaterial;
  material.fog = false; // replaced by the atmosphere block below
  const m = textures.maps;
  const mineralColor = { value: new Color('#b45cff') };
  const mineralIntensity = { value: mineral ? 0.35 : 0 };
  Object.assign(material.userData, { mineralColor, mineralIntensity });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tCliffA: { value: m.cliff.albedo }, tCliffN: { value: m.cliff.normal }, tCliffR: { value: m.cliff.arm },
      tTopA: { value: m.top.albedo }, tTopN: { value: m.top.normal }, tTopR: { value: m.top.arm },
      tBaseA: { value: m.base.albedo }, tBaseN: { value: m.base.normal }, tBaseR: { value: m.base.arm },
      uScales: { value: scales }, uCliffTint: { value: cliffTint }, uTopTint: { value: new Color('#aba3c6') },
      uBaseTint: { value: new Color('#7f78b0') }, uMineralColor: mineralColor, uMineral: mineralIntensity,
      uHazeScale: { value: hazeScale },
      uRimStrength: { value: rim }, uRimA: { value: new Color('#e04cff') }, uRimB: { value: new Color('#3a63ff') },
      uStormIntensity: { value: storm ? 1.5 : 0 }, uStormA: { value: new Color('#3b1d9e') }, uStormB: { value: new Color('#a21fd6') }, uStormC: { value: new Color('#ff7be8') },
      ...atmosphere,
    });
    shader.vertexShader = VERTEX_PARS + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vObjPos = position; vObjNormal = normal; vTerrain = terrain;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vAtmoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = (storm ? '#define ROCK_STORM\n' : '') + FRAGMENT_PARS + shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
  #ifdef ROCK_STORM
  // Torn breaches in the cavern wall reveal the storm beyond; their rims glow.
  float breach = rockNoise(vAtmoWorld * 0.0065) * 0.45 + rockNoise(vAtmoWorld * 0.021 + 4.0) * 0.33 + rockNoise(vAtmoWorld * 0.07 + 9.0) * 0.22;
  if (breach > 0.66) discard;
  float breachEdge = smoothstep(0.652, 0.66, breach) * smoothstep(0.35, 0.8, rockNoise(vAtmoWorld * 0.12));
  #endif
  vec3 rockN = normalize(vObjNormal);
  vec3 dpdx = dFdx(vObjPos), dpdy = dFdy(vObjPos);
  vec3 tw = pow(abs(rockN), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
  float macro = rockNoise(vObjPos * uScales.w * 4.0) * 0.65 + rockNoise(vObjPos * uScales.w * 13.0) * 0.35;
  float cavity = vTerrain.x;
  float topW = smoothstep(0.32, 0.72, vTerrain.y + (macro - 0.5) * 0.5);
  float baseW = (1.0 - smoothstep(0.18, 0.62, vTerrain.z + (macro - 0.5) * 0.35)) * (1.0 - topW);
  baseW = max(baseW, smoothstep(-0.35, -0.8, rockN.y) * (1.0 - topW) * 0.75);
  float cliffW = max(0.0, 1.0 - topW - baseW);
  vec3 rockAlbedo = vec3(0.0), rockArm = vec3(0.0), rockNormal = vec3(0.0);
  if (cliffW > 0.01) {
    RockSample c = triplanar(tCliffA, tCliffN, tCliffR, vObjPos, rockN, tw, uScales.x, dpdx, dpdy);
    // Strata colouring: alternating cool/warm bands following object height.
    float band = sin(vObjPos.y * 2.3 + macro * 3.0) * 0.5 + 0.5;
    vec3 tint = uCliffTint * mix(vec3(0.92, 0.95, 1.04), vec3(1.07, 1.0, 0.94), band);
    rockAlbedo += recolor(c.albedo, tint, 0.18) * cliffW; rockArm += c.arm * cliffW; rockNormal += c.normal * cliffW;
  }
  if (topW > 0.01) {
    RockSample t = planarTop(tTopA, tTopN, tTopR, vObjPos, rockN, uScales.y, dpdx, dpdy);
    rockAlbedo += recolor(t.albedo, uTopTint * mix(0.85, 1.12, macro), 0.25) * topW; rockArm += t.arm * topW; rockNormal += t.normal * topW;
  }
  if (baseW > 0.01) {
    RockSample b = triplanar(tBaseA, tBaseN, tBaseR, vObjPos, rockN, tw, uScales.z, dpdx, dpdy);
    rockAlbedo += recolor(b.albedo, uBaseTint, 0.12) * baseW; rockArm += b.arm * baseW; rockNormal += b.normal * baseW;
  }
  rockAlbedo *= mix(0.78, 1.15, macro);
  // Cavity darkening for direct light; the full value also attenuates indirect light.
  diffuseColor.rgb *= rockAlbedo * mix(0.45, 1.0, cavity);
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(roughness * rockArm.g * 1.05 + (1.0 - topW) * 0.04, 0.35, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize(normalMatrix * normalize(rockNormal));\n  #ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n  #endif')
      .replace('#include <emissivemap_fragment>', /* glsl */`
  // Mineral seams glow only in deep crevices; intensity follows the island's
  // sampled field hazard (set per island from the simulation, never invented).
  float vein = 1.0 - abs(rockNoise(vObjPos * vec3(2.2, 5.5, 2.2)) * 2.0 - 1.0);
  float seam = smoothstep(0.95, 0.99, vein) * (1.0 - smoothstep(0.3, 0.6, cavity)) * (1.0 - topW);
  totalEmissiveRadiance += uMineralColor * uMineral * seam;
  // Luminous dimensional rims: fresnel glow, hue drifting magenta to cobalt.
  float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
  vec3 rimTint = mix(uRimA, uRimB, rockNoise(vAtmoWorld * 0.035));
  totalEmissiveRadiance += rimTint * fres * uRimStrength * (0.35 + 0.65 * (1.0 - topW));
  #ifdef ROCK_STORM
  vec3 sq = vAtmoWorld * 0.016; float storm = 0.0, sa = 0.5;
  for (int i = 0; i < 4; i++) { storm += sa * rockNoise(sq); sq = sq * 2.07 + 3.1; sa *= 0.5; }
  float glow = smoothstep(0.5, 0.72, storm);
  vec3 stormTint = mix(uStormA, uStormB, smoothstep(0.25, 0.8, rockNoise(sq * 0.11 + 5.0)));
  stormTint = mix(stormTint, uStormC, glow * glow * glow);
  totalEmissiveRadiance += stormTint * glow * glow * uStormIntensity + uStormC * breachEdge * 0.9;
  #endif
`)
      .replace('#include <aomap_fragment>', /* glsl */`
  float rockAO = mix(1.0, rockArm.r, 0.8) * mix(0.25, 1.0, cavity);
  reflectedLight.indirectDiffuse *= rockAO;
  reflectedLight.indirectSpecular *= rockAO;
`)
      .replace('#include <tonemapping_fragment>', /* glsl */`
  vec3 atmoRay = vAtmoWorld - cameraPosition;
  float atmoDist = length(atmoRay);
  float atmoDensity = uHazeDensity * uHazeScale;
  float haze = 1.0 - exp(-atmoDensity * atmoDensity * atmoDist * atmoDist);
  // Height-dependent haze thickens below the island field (cloud sea).
  float low = clamp((uHazeFloor - vAtmoWorld.y) / 30.0, 0.0, 1.0);
  haze = clamp(haze + low * low * 0.55 * (1.0 - exp(-atmoDist * 0.012 * uHazeScale)), 0.0, 1.0);
  vec3 skyHaze = textureLod(uSkyHaze, normalize(atmoRay), uHazeMip).rgb * uHazeTint;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, skyHaze, haze);
  #include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `fractured-rock-${mineral ? 1 : 0}-${storm ? 1 : 0}`;
  return material;
}

export const ROCK_SCALES = { island: new Vector4(0.16, 0.34, 0.24, 0.08), distant: new Vector4(0.022, 0.05, 0.035, 0.012) };
