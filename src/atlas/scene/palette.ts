import { Color } from 'three';

/** Colour language sampled from the approved Fractured Dimension nebula reference.
 * Hex values are sRGB; THREE converts them to linear working space. */
export const PALETTE = {
  indigo: '#04063a',
  cosmicBlue: '#001070',
  cobalt: '#0a2cb4',
  darkViolet: '#4a109c',
  violet: '#8020b0',
  purple: '#a020c0',
  magenta: '#d238dc',
  orchid: '#e467e6',
  lilac: '#f0b4f4',
  amber: '#ffb35c',
} as const;

export const linear = (hex: string): Color => new Color(hex);

/** Shared GLSL: hash, 3D value noise and fBm. Kept small because ANGLE inlines loops. */
export const NOISE_GLSL = /* glsl */`
float h13(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.875; }
float fbm5(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.96875; }
`;
