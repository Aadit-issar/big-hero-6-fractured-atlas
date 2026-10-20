import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, BackSide, BufferGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, Mesh, ShaderMaterial,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector2, Vector3, CatmullRomCurve3,
} from 'three';
import type { SceneModel } from './sceneModel';
import { KEY_LIGHT } from './NebulaSky';
import { PALETTE, linear } from './palette';
import { smooth } from './timing';

const BODY_V = /* glsl */`varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() { vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;

// Soft white medical-robot shell: wrapped key light, magenta nebula bounce from below, lilac rim, faint panel seams.
const BODY_F = /* glsl */`
uniform vec3 uCam, uLight, uTint, uBounce; uniform float uGlow; uniform float uSeam;
varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() {
  vec3 N = normalize(vN), V = normalize(uCam - vW);
  float wrap = dot(N, uLight) * 0.5 + 0.5;
  vec3 col = uTint * (0.36 + 0.78 * smoothstep(0.0, 1.0, wrap));
  col += uBounce * max(-N.y, 0.0) * 0.55;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  col += vec3(0.85, 0.6, 1.0) * fres * 0.55;
  vec3 H = normalize(uLight + V);
  col += vec3(1.0, 0.95, 1.0) * pow(max(dot(N, H), 0.0), 38.0) * 0.28;
  float seam = uSeam * (1.0 - smoothstep(0.0, 0.025, abs(fract(vL.y * 0.62 + 0.18) - 0.5) - 0.47) );
  col *= 1.0 - 0.14 * seam;
  col += uGlow * vec3(0.95, 0.7, 1.0) * (0.25 + fres);
  gl_FragColor = vec4(col, 1.0);
}`;

const PLUME_V = /* glsl */`varying float vT; varying vec3 vN; varying vec3 vW;
void main() { vT = position.y; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const PLUME_F = /* glsl */`
uniform float uTime, uIntensity, uSeed; uniform vec3 uCam, uCore, uOuter;
varying float vT; varying vec3 vN; varying vec3 vW;
void main() {
  vec3 V = normalize(uCam - vW);
  float facing = pow(abs(dot(normalize(vN), V)), 1.3);
  float flick = 0.82 + 0.18 * sin(uTime * 37.0 + uSeed * 9.0 + vT * 11.0) * sin(uTime * 23.0 + uSeed);
  float fall = pow(1.0 - clamp(vT, 0.0, 1.0), 1.5);
  vec3 col = mix(uOuter, uCore, pow(1.0 - vT, 2.2));
  gl_FragColor = vec4(col * (0.7 + 1.9 * fall), uIntensity * fall * facing * flick);
}`;

const FLAT_F = /* glsl */`uniform vec3 uColor; varying vec3 vN; void main() { gl_FragColor = vec4(uColor * (0.5 + 0.5 * normalize(vN).y * 0.5 + 0.25), 1.0); }`;

/** Procedural Baymax with a back thruster pack and foot jets. The authoritative input is the observer position in the model;
 * everything else (smoothing, heading, lean, thrust, scan pose) is presentation animation derived from that motion. */
export function BaymaxActor({ modelRef, ambient, onSelect }: { readonly modelRef: { current: SceneModel }; readonly ambient: { current: number }; readonly onSelect?: (id: string) => void }) {
  const root = useRef<Group>(null);
  const state = useRef({ pos: new Vector3(), vel: new Vector3(), yaw: 0, bank: 0, init: false, speed: 0, last: new Vector3(), scan: 0, thrust: 0 });
  const assets = useMemo(() => {
    const torsoProfile = [[0, -1.58], [0.5, -1.54], [0.98, -1.3], [1.32, -0.8], [1.45, -0.1], [1.34, 0.6], [1.02, 1.12], [0.62, 1.44], [0.2, 1.54], [0, 1.55]].map(p => new Vector2(p[0], p[1]));
    const torso = new LatheGeometry(torsoProfile, 40);
    const head = new SphereGeometry(0.7, 32, 20);
    const capsuleArm = new CapsuleGeometry(0.3, 1.0, 8, 16);
    const capsuleLeg = new CapsuleGeometry(0.5, 0.3, 8, 16);
    const eye = new SphereGeometry(1, 12, 8);
    const faceCurve = new CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => {
      const x = -0.36 + (0.72 * i) / 8;
      const z = 0.644 * Math.sqrt(Math.max(0, 1 - (x / 0.7) ** 2 - (0.06 / 0.574) ** 2)) + 0.012;
      return new Vector3(x, 0.06, z);
    }));
    const faceLine = new TubeGeometry(faceCurve, 24, 0.017, 6, false);
    const pack = new CapsuleGeometry(0.34, 0.7, 6, 14);
    const nozzle = new CylinderGeometry(0.2, 0.28, 0.3, 16, 1, true);
    const plume = new ConeGeometry(0.27, 1, 20, 1, true);
    plume.translate(0, 0.5, 0); // base at the nozzle exit, apex downstream
    const ring = new TorusGeometry(1.0, 0.035, 8, 64);
    const seamRing = new TorusGeometry(1, 0.016, 6, 64);
    const body = new ShaderMaterial({
      vertexShader: BODY_V, fragmentShader: BODY_F, side: DoubleSide,
      uniforms: { uCam: { value: new Vector3() }, uLight: { value: KEY_LIGHT.clone() }, uTint: { value: new Color('#fffaff') }, uBounce: { value: linear(PALETTE.magenta).multiplyScalar(0.7) }, uGlow: { value: 0 }, uSeam: { value: 1 } },
    });
    const metal = new ShaderMaterial({
      vertexShader: BODY_V, fragmentShader: BODY_F, side: DoubleSide,
      uniforms: { uCam: { value: new Vector3() }, uLight: { value: KEY_LIGHT.clone() }, uTint: { value: new Color('#6a5a96') }, uBounce: { value: linear(PALETTE.magenta).multiplyScalar(0.6) }, uGlow: { value: 0 }, uSeam: { value: 0 } },
    });
    const dark = new ShaderMaterial({ vertexShader: BODY_V, fragmentShader: FLAT_F, uniforms: { uColor: { value: new Color('#0d0620') } } });
    const emitter = new ShaderMaterial({
      vertexShader: BODY_V, fragmentShader: /* glsl */`uniform float uA; varying vec3 vN; void main() { gl_FragColor = vec4(vec3(1.0, 0.85, 1.0) * 1.6, uA); }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uA: { value: 0 } },
    });
    const plumeMat = () => new ShaderMaterial({
      vertexShader: PLUME_V, fragmentShader: PLUME_F, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uSeed: { value: Math.random() }, uCam: { value: new Vector3() }, uCore: { value: new Color('#ffe9ff').multiplyScalar(1.4) }, uOuter: { value: linear(PALETTE.purple).multiplyScalar(1.2) } },
    });
    const halo = new ShaderMaterial({
      vertexShader: BODY_V, fragmentShader: /* glsl */`uniform vec3 uCam; uniform float uA; varying vec3 vN; varying vec3 vW;
        void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 3.0); gl_FragColor = vec4(vec3(1.0, 0.8, 1.0) * (0.2 + f * 1.4), uA * (0.04 + f)); }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: BackSide, uniforms: { uCam: { value: new Vector3() }, uA: { value: 0.3 } },
    });
    const plumeMats = [plumeMat(), plumeMat(), plumeMat(), plumeMat()];
    const glowGeo = new SphereGeometry(0.2, 12, 8);
    const glowMat = new ShaderMaterial({ vertexShader: BODY_V, fragmentShader: /* glsl */`uniform float uA; varying vec3 vN; void main() { gl_FragColor = vec4(vec3(1.0, 0.82, 1.0) * 2.0, uA); }`, transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uA: { value: 0 } } });
    return { glowGeo, glowMat, torso, head, capsuleArm, capsuleLeg, eye, faceLine, pack, nozzle, plume, ring, seamRing, body, metal, dark, emitter, halo, plumeMats };
  }, []);
  useEffect(() => () => {
    const a = assets;
    [a.glowGeo, a.torso, a.head, a.capsuleArm, a.capsuleLeg, a.eye, a.faceLine, a.pack, a.nozzle, a.plume, a.ring, a.seamRing].forEach((g: BufferGeometry) => g.dispose());
    [a.glowMat, a.body, a.metal, a.dark, a.emitter, a.halo, ...a.plumeMats].forEach(m => m.dispose());
  }, [assets]);

  const refs = useRef<{ lean: Group | null; armL: Group | null; armR: Group | null; head: Group | null; ring: Mesh | null; plumes: (Mesh | null)[]; glows: (Mesh | null)[] }>({ lean: null, armL: null, armR: null, head: null, ring: null, plumes: [null, null, null, null], glows: [null, null, null, null] });

  useFrame(({ camera }, delta) => {
    const model = modelRef.current, g = root.current, r = refs.current;
    if (!g || !r.lean) return;
    // Before the first observation the character stands at his hero mark (the opening); afterwards the observer is authoritative.
    const o = model.observer ?? (model.hero ? { position: model.hero, firstSeenAt: -10 } : null);
    g.visible = !!o && model.time >= o.firstSeenAt;
    if (!o) return;
    const s = state.current, dt = Math.min(0.05, Math.max(0.001, delta));
    const target = new Vector3(o.position[0], o.position[1], o.position[2]);
    if (!s.init || s.pos.distanceTo(target) > 80) { s.pos.copy(target); s.last.copy(target); s.init = true; }
    // Smooth follow of the authoritative position; the model never leads or invents a path.
    s.pos.lerp(target, 1 - Math.exp(-dt * 5));
    const v = s.pos.clone().sub(s.last).divideScalar(dt); s.last.copy(s.pos);
    s.vel.lerp(v, 1 - Math.exp(-dt * 8));
    s.speed = s.vel.length();
    const speedN = smooth(s.speed / model.motionReference);
    // Heading: face the direction of travel while moving, otherwise turn to face the viewer.
    const horizontal = Math.hypot(s.vel.x, s.vel.z);
    const toCam = Math.atan2(camera.position.x - s.pos.x, camera.position.z - s.pos.z);
    const want = horizontal > 0.35 ? Math.atan2(s.vel.x, s.vel.z) : toCam;
    let dy = want - s.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const yawRate = dy * (1 - Math.exp(-dt * (horizontal > 0.35 ? 3.2 : 1.1)));
    s.yaw += yawRate;
    s.bank += (Math.max(-0.28, Math.min(0.28, -yawRate / dt * 0.12)) - s.bank) * (1 - Math.exp(-dt * 4));
    const t = ambient.current;
    const bob = Math.sin(t * 1.3) * 0.1 + Math.sin(t * 0.7 + 1.3) * 0.05;
    g.position.set(s.pos.x, s.pos.y + bob, s.pos.z);
    g.rotation.y = s.yaw;
    const appear = smooth((model.time - o.firstSeenAt) / 1.2);
    g.scale.setScalar(1.18 * (0.4 + 0.6 * appear));
    // Scan pose from the latest pulse.
    const pulse = model.pulses.length ? model.pulses[model.pulses.length - 1]! : null;
    const age = pulse ? model.time - pulse.atS : 99;
    const scanTarget = pulse && age >= 0 && age < 1.5 ? Math.sin(Math.min(1, age / 1.5) * Math.PI) : 0;
    s.scan += (scanTarget - s.scan) * (1 - Math.exp(-dt * 10));
    r.lean.rotation.x = speedN * 0.32; r.lean.rotation.z = s.bank;
    if (r.armL) { r.armL.rotation.z = -0.3 - 0.07 * Math.sin(t * 1.3) - s.scan * 0.55 - speedN * 0.12; r.armL.rotation.x = -s.scan * 0.55; }
    if (r.armR) { r.armR.rotation.z = 0.3 + 0.07 * Math.sin(t * 1.3 + 1) + s.scan * 0.55 + speedN * 0.12; r.armR.rotation.x = -s.scan * 0.55; }
    if (r.head) { r.head.rotation.x = -0.05 - speedN * 0.08 + s.scan * 0.12; r.head.rotation.y = Math.sin(t * 0.4) * 0.05; }
    if (r.ring) {
      const ringScale = 1.6 + s.scan * 1.2;
      r.ring.scale.set(ringScale, ringScale, ringScale);
      r.ring.visible = s.scan > 0.02;
      assets.emitter.uniforms.uA!.value = 0.85 * s.scan;
    }
    // Thrusters: foot jets hover at low power and rise with speed; the back pack fires with speed; idle jets are decorative.
    const idle = 0.3, feet = idle + 0.5 * speedN, pack = 0.06 + 0.94 * speedN;
    assets.glowMat.uniforms.uA!.value = 0.7;
    s.thrust = speedN;
    assets.plumeMats.forEach((m, i) => {
      const u = m.uniforms;
      u.uTime!.value = t; (u.uCam!.value as Vector3).copy(camera.position);
      const intensity = i < 2 ? feet : pack;
      u.uIntensity!.value = intensity * 0.9;
      const mesh = r.plumes[i];
      if (mesh) { mesh.scale.set(1, 0.5 + (i < 2 ? 2.0 : 4.2) * intensity, 1); mesh.visible = intensity > 0.02; }
      const glow = r.glows[i];
      if (glow) { glow.scale.setScalar(0.5 + 1.5 * intensity); glow.visible = intensity > 0.02; }
    });
    (assets.body.uniforms.uCam!.value as Vector3).copy(camera.position);
    (assets.metal.uniforms.uCam!.value as Vector3).copy(camera.position);
    (assets.halo.uniforms.uCam!.value as Vector3).copy(camera.position);
    assets.body.uniforms.uGlow!.value = s.scan * 0.35;
    assets.halo.uniforms.uA!.value = 0.2 + 0.22 * appear;
  });

  const { body, metal, dark, emitter, plumeMats } = assets;
  return (
    <group ref={root} name="baymax-observer" visible={false} onClick={e => { e.stopPropagation(); onSelect?.('baymax-observer'); }}>
      <group ref={el => { refs.current.lean = el; }}>
        <mesh geometry={assets.torso} material={body} scale={[1, 1, 0.88]} />
        <mesh geometry={assets.seamRing} material={assets.dark} position={[0, -0.45, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1.43, 1.26, 1]} />
        <group ref={el => { refs.current.head = el; }} position={[0, 1.72, 0]}>
          <mesh geometry={assets.head} material={body} scale={[1.0, 0.82, 0.92]} />
          <mesh geometry={assets.eye} material={dark} position={[-0.36, 0.06, 0.552]} scale={[0.085, 0.115, 0.045]} />
          <mesh geometry={assets.eye} material={dark} position={[0.36, 0.06, 0.552]} scale={[0.085, 0.115, 0.045]} />
          <mesh geometry={assets.faceLine} material={dark} />
        </group>
        <group ref={el => { refs.current.armL = el; }} position={[-1.34, 0.62, 0.04]}>
          <mesh geometry={assets.capsuleArm} material={body} position={[-0.12, -0.62, 0]} />
        </group>
        <group ref={el => { refs.current.armR = el; }} position={[1.34, 0.62, 0.04]}>
          <mesh geometry={assets.capsuleArm} material={body} position={[0.12, -0.62, 0]} />
        </group>
        <mesh geometry={assets.capsuleLeg} material={body} position={[-0.62, -1.72, 0.06]} />
        <mesh geometry={assets.capsuleLeg} material={body} position={[0.62, -1.72, 0.06]} />
        {/* Back thruster pack and nozzles (armour-inspired, restrained). */}
        <mesh geometry={assets.pack} material={metal} position={[0, 0.15, -1.08]} rotation={[0, 0, Math.PI / 2]} scale={[1, 1, 0.9]} />
        <mesh geometry={assets.nozzle} material={metal} position={[-0.52, -0.38, -1.34]} rotation={[-Math.PI / 2 - 0.2, 0, 0]} />
        <mesh geometry={assets.nozzle} material={metal} position={[0.52, -0.38, -1.34]} rotation={[-Math.PI / 2 - 0.2, 0, 0]} />
        <mesh geometry={assets.nozzle} material={metal} position={[-0.62, -2.18, 0.06]} />
        <mesh geometry={assets.nozzle} material={metal} position={[0.62, -2.18, 0.06]} />
        {/* Plumes: feet jets point down; pack jets trail behind (body-relative -z). */}
        <mesh ref={el => { refs.current.plumes[0] = el; }} geometry={assets.plume} material={plumeMats[0]!} position={[-0.62, -2.3, 0.06]} rotation={[Math.PI, 0, 0]} />
        <mesh ref={el => { refs.current.plumes[1] = el; }} geometry={assets.plume} material={plumeMats[1]!} position={[0.62, -2.3, 0.06]} rotation={[Math.PI, 0, 0]} />
        <mesh ref={el => { refs.current.plumes[2] = el; }} geometry={assets.plume} material={plumeMats[2]!} position={[-0.52, -0.5, -1.42]} rotation={[-Math.PI / 2 - 0.25, 0, 0]} />
        <mesh ref={el => { refs.current.plumes[3] = el; }} geometry={assets.plume} material={plumeMats[3]!} position={[0.52, -0.5, -1.42]} rotation={[-Math.PI / 2 - 0.25, 0, 0]} />
        {[[-0.62, -2.3, 0.06], [0.62, -2.3, 0.06], [-0.52, -0.5, -1.42], [0.52, -0.5, -1.42]].map((p, i) => <mesh key={i} ref={el => { refs.current.glows[i] = el; }} geometry={assets.glowGeo} material={assets.glowMat} position={p as [number, number, number]} />)}
        <mesh ref={el => { refs.current.ring = el; }} geometry={assets.ring} material={emitter} position={[0, 0.5, 0.2]} rotation={[Math.PI / 2, 0, 0]} visible={false} />
        <mesh geometry={assets.head} material={assets.halo} scale={[2.9, 3.6, 2.7]} position={[0, 0.1, 0]} />
      </group>
    </group>
  );
}
