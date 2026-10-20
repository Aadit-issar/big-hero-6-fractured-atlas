import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { HalfFloatType, LinearFilter, Matrix4, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector3, WebGLRenderTarget } from 'three';
import type { PerspectiveCamera } from 'three';
import { NOISE_GLSL, PALETTE, linear } from './palette';

/** Direction toward the key light (shared with island shading). */
export const KEY_LIGHT = new Vector3(-0.45, 0.62, -0.64).normalize();

const VERTEX = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Three parallax cloud layers over a cobalt void. Cumulus-like billows: warped fBm, thresholded with a
// grainy edge, self-lit toward the key light. Purely atmospheric: it carries no ATLAS knowledge.
const FRAGMENT = /* glsl */`
uniform float uTime;
uniform vec3 uCam, uLight;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 cIndigo, cCosmic, cCobalt, cDark, cViolet, cPurple, cMagenta, cOrchid, cLilac;
varying vec2 vUv;
${NOISE_GLSL}
// One cloud layer. Returns the cloud value n (0 = void); crest = light-facing fraction.
float billow(vec3 p) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); n += a; p = p * 2.07 + 13.3; a *= 0.58; } return s / n; }
float layer(vec3 d, float scale, float parallax, float t, out float crest, out float shade, out float mott) {
  vec3 p = d * scale + uCam * parallax + vec3(0.9, 0.12, 0.45) * t;
  float w = fbm3(p * 0.5 + 4.1);
  p += (w - 0.5) * vec3(1.15, 0.6, 0.9);
  float n = billow(p);
  float grain = vnoise(p * 17.0) * 0.6 + vnoise(p * 41.0) * 0.4;
  float lit = fbm3(p + uLight * 0.2);
  mott = vnoise(p * 7.3) * 0.6 + vnoise(p * 16.0) * 0.4;
  crest = clamp(0.5 + (n - lit) * 4.0 + (mott - 0.5) * 0.7, 0.0, 1.0);
  shade = w;
  return n + (grain - 0.5) * 0.15;
}
void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 view = uProjInv * ndc; view /= view.w;
  vec3 d = normalize((uCamWorld * vec4(normalize(view.xyz), 0.0)).xyz);
  float t = uTime * 0.014;
  // Cobalt void with large slow tonal variation (clearly visible between the clouds).
  float v = fbm3(d * 1.4 + vec3(2.0, 0.0, 5.0));
  vec3 col = mix(cCosmic, cCobalt, smoothstep(0.2, 0.7, v));
  col = mix(col, cIndigo, smoothstep(0.7, 1.0, 1.0 - d.y * 0.5 - v * 0.4) * 0.3);
  float crest, shade, mott, n, dens, core;
  // Far: deep violet billows, sparse.
  n = layer(d, 1.9, 0.0010, t * 0.6, crest, shade, mott);
  dens = smoothstep(0.575, 0.64, n);
  col = mix(col, mix(cDark, cViolet, 0.45 + crest * 0.5), dens * 0.8);
  // Mid: purple.
  n = layer(d, 2.7, 0.0030, t * 0.85 + 11.0, crest, shade, mott);
  dens = smoothstep(0.54, 0.62, n); core = smoothstep(0.55, 0.74, n);
  vec3 midCol = mix(mix(cViolet, cPurple, shade), mix(cPurple, cMagenta, crest), core * (0.35 + 0.65 * crest) + 0.25) * (0.85 + 0.3 * mott);
  col = mix(col, midCol, dens * 0.95);
  // Near: bright magenta cumulus with orchid cores and pale lilac crests.
  n = layer(d, 3.6, 0.0075, t * 1.2 + 23.0, crest, shade, mott);
  dens = smoothstep(0.55, 0.63, n); core = smoothstep(0.56, 0.76, n);
  vec3 body = mix(cViolet, cPurple, 0.25 + shade * 0.5);
  vec3 lit = mix(cPurple, cMagenta, smoothstep(0.1, 0.8, core));
  vec3 nearCol = mix(body, lit, 0.4 + core * 0.6) * (0.82 + 0.36 * mott);
  nearCol = mix(nearCol, cOrchid, crest * core * 0.8);
  nearCol += cLilac * crest * crest * core * 0.4;
  col = mix(col, nearCol, dens * 0.97);
  gl_FragColor = vec4(col, 1.0);
}`;

const SHOW_V = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }`;
const SHOW_F = /* glsl */`uniform sampler2D tSky; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSky, vUv).rgb, 1.0); }`;

/** The nebula is smooth, so it is rendered into a reduced-resolution target each frame and upsampled: about 4x cheaper than
 * evaluating the layered noise per output pixel. `scale` is the linear resolution fraction. */
export function NebulaSky({ sceneTime, scale = 0.6, gate }: { readonly sceneTime: { current: number }; readonly scale?: number; readonly gate?: { current: boolean } }) {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, depthWrite: false, depthTest: false,
    uniforms: {
      uTime: { value: 0 }, uCam: { value: new Vector3() }, uLight: { value: KEY_LIGHT.clone() }, uProjInv: { value: new Matrix4() }, uCamWorld: { value: new Matrix4() },
      cIndigo: { value: linear(PALETTE.indigo) }, cCosmic: { value: linear(PALETTE.cosmicBlue) }, cCobalt: { value: linear(PALETTE.cobalt) },
      cDark: { value: linear(PALETTE.darkViolet) }, cViolet: { value: linear(PALETTE.violet) }, cPurple: { value: linear(PALETTE.purple) },
      cMagenta: { value: linear(PALETTE.magenta) }, cOrchid: { value: linear(PALETTE.orchid) }, cLilac: { value: linear(PALETTE.lilac) },
    },
  }), []);
  const target = useMemo(() => new WebGLRenderTarget(2, 2, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter }), []);
  const offscreen = useMemo(() => {
    const quadScene = new Scene(), quad = new Mesh(new PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    quadScene.add(quad);
    return { quadScene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), quad };
  }, [material]);
  const show = useMemo(() => new ShaderMaterial({ vertexShader: SHOW_V, fragmentShader: SHOW_F, depthWrite: false, depthTest: false, uniforms: { tSky: { value: target.texture } } }), [target]);
  const geometry = useMemo(() => new PlaneGeometry(2, 2), []);
  useEffect(() => () => { material.dispose(); target.dispose(); show.dispose(); geometry.dispose(); offscreen.quad.geometry.dispose(); }, [material, target, show, geometry, offscreen]);
  useFrame(({ gl, camera, size }) => {
    if (gate && !gate.current) return;
    const cam = camera as PerspectiveCamera;
    const pr = gl.getPixelRatio();
    const w = Math.max(2, Math.round(size.width * pr * scale)), h = Math.max(2, Math.round(size.height * pr * scale));
    if (target.width !== w || target.height !== h) target.setSize(w, h);
    const u = material.uniforms;
    u.uTime!.value = sceneTime.current;
    (u.uCam!.value as Vector3).copy(cam.position);
    (u.uProjInv!.value as Matrix4).copy(cam.projectionMatrixInverse);
    (u.uCamWorld!.value as Matrix4).copy(cam.matrixWorld);
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    gl.render(offscreen.quadScene, offscreen.camera);
    gl.setRenderTarget(previous);
  });
  return <mesh ref={mesh} geometry={geometry} material={show} renderOrder={-100} frustumCulled={false} />;
}
