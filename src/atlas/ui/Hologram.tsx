import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AtlasView } from '../core/runtime';
import type { WorldVec3 } from '../../shared/atlasContract';
import type { PublishedPosition } from '../lab/missionReplay';

const v3 = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
export interface HologramProps {
  view: AtlasView; chapter: number; selected: string | null; onSelect: (id: string) => void;
  guided: boolean; onManual: () => void; reduced: boolean; published?: readonly PublishedPosition[];
}

function Trail({ points, color = '#c677b3', dashed = false, opacity = 0.5, segments = false }: { points: readonly (readonly number[])[]; color?: string; dashed?: boolean; opacity?: number; segments?: boolean }) {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(v3));
    const material = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.45, transparent: true, opacity }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const result = segments ? new THREE.LineSegments(geometry, material) : new THREE.Line(geometry, material); result.computeLineDistances(); return result;
  }, [points, color, dashed, opacity, segments]);
  useEffect(() => () => { line.geometry.dispose(); (line.material as THREE.Material).dispose(); }, [line]);
  return <primitive object={line} />;
}

function SignalLabel({ text, position, color = '#f2eaf7', offset = 6 }: { text: string; position: WorldVec3; color?: string; offset?: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.font = '500 38px Arial'; context.textAlign = 'center'; context.fillStyle = color;
    context.shadowColor = '#130d3c'; context.shadowBlur = 8; context.fillText(text, 384, 60);
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map;
  }, [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite position={[position[0], position[1] + offset, position[2]]} scale={[.24, .03, 1]} renderOrder={10}><spriteMaterial map={texture} transparent depthTest={false} sizeAttenuation={false} /></sprite>;
}

function Island({ position, id, current, selected, onSelect, variant, showLabel }: { position: WorldVec3; id: string; current: boolean; selected: boolean; onSelect: () => void; variant: number; showLabel: boolean }) {
  const surface = useRef<THREE.MeshStandardMaterial>(null);
  const reveal = useRef<THREE.Group>(null);
  const age = useRef(0);
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useFrame((_, delta) => {
    age.current += delta;
    if (surface.current) surface.current.opacity = THREE.MathUtils.damp(surface.current.opacity, current ? 1 : 0.2, 3, delta);
    if (reveal.current) reveal.current.scale.setScalar(reduced ? 1 : Math.min(1, 0.5 + age.current * 0.7));
  });
  const geometry = useMemo(() => {
    const vertices: number[] = [];
    const n = 9;
    const ring = Array.from({ length: n }, (_, i) => {
      const angle = i / n * Math.PI * 2;
      const radius = 3.6 + Math.sin(i * 3.7 + variant) * 0.85;
      return [Math.cos(angle) * radius, 0.4 + Math.sin(i * 2 + variant) * 0.6, Math.sin(angle) * radius];
    });
    const lower = ring.map((p,i) => [p[0]! * .55, -2.5 - Math.sin(i * 2.9 + variant), p[2]! * .63]);
    const inner = ring.map((p,i) => [p[0]! * .48, 1.1 + Math.sin(i * 3.1 + variant) * .8, p[2]! * .48]);
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!;
      const c = lower[i]!, d = lower[(i + 1) % n]!;
      const e = inner[i]!, f = inner[(i + 1) % n]!;
      vertices.push(-.7, 1.5, .6, ...f, ...e, ...e, ...f, ...a, ...a, ...f, ...b, ...a, ...b, ...c, ...b, ...d, ...c, ...c, ...d, .4, -6.1, -.3);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geo.computeVertexNormals(); return geo;
  }, [variant]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <group position={[...position]} ref={reveal}>
    <mesh geometry={geometry} onClick={e => { e.stopPropagation(); onSelect(); }}>
      <meshStandardMaterial ref={surface} color={current ? '#65566e' : '#342547'} emissive={selected ? '#b33fc1' : '#2e0859'} emissiveIntensity={selected ? 0.6 : 0.12} roughness={0.85} transparent opacity={current ? 1 : 0.2} flatShading />
    </mesh>
    <mesh geometry={geometry}><meshBasicMaterial color={selected ? '#f2eaf7' : '#c677b3'} wireframe transparent opacity={current ? 0.15 : 0.1} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.45, 0]}><ringGeometry args={[4.2, 4.24, 64]} /><meshBasicMaterial color="#e692cb" transparent opacity={current ? 0.4 : 0.12} side={THREE.DoubleSide} /></mesh>
    {showLabel && <SignalLabel text={`${id}${current ? '' : ' · MEMORY'}`} position={[0, 0, 0]} color={current ? '#f2eaf7' : '#a58bad'} />}
  </group>;
}

function Aperture({ position, ghost = false, selected = false, sealed = false, onClick }: { position: readonly number[]; ghost?: boolean; selected?: boolean; sealed?: boolean; onClick?: () => void }) {
  const geometry = useMemo(() => {
    const points = Array.from({ length: 65 }, (_, i) => {
      const a = i / 64 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * (0.85 + Math.sin(a * 7) * 0.13), Math.sin(a) * 4, Math.sin(a * 3) * 0.16);
    });
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.075, 5, false);
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (sealed) return <group position={v3(position)}><mesh onClick={e => { e.stopPropagation(); onClick?.(); }}><boxGeometry args={[.15, 8, .15]} /><meshBasicMaterial color="#e5a888" /></mesh></group>;
  return <group position={v3(position)} rotation={[0, -0.3, -0.16]}>
    <mesh scale={[1.7, 4.5, .8]} onClick={e => { e.stopPropagation(); onClick?.(); }}><sphereGeometry args={[1, 8, 8]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
    <mesh geometry={geometry}><meshBasicMaterial color={selected ? '#fff2fc' : '#e692cb'} transparent opacity={ghost ? 0.25 : 1} /></mesh>
    <mesh geometry={geometry} scale={[1.24, 1.02, 1.3]}><meshBasicMaterial color="#b33fc1" transparent opacity={ghost ? 0.08 : 0.3} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
    <mesh visible={!ghost} onClick={e => { e.stopPropagation(); onClick?.(); }} scale={[0.8, 3.8, 0.25]}><sphereGeometry args={[1, 12, 12]} /><meshBasicMaterial color="#160a24" /></mesh>
  </group>;
}

function CameraDirector({ view, chapter, selected, guided, onManual, reduced }: HologramProps) {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  useEffect(() => {
    controls.enableDamping = !reduced; controls.dampingFactor = 0.08; controls.minDistance = 18; controls.maxDistance = 1800; controls.maxPolarAngle = Math.PI * 0.85;
    controls.addEventListener('start', onManual);
    return () => controls.removeEventListener('start', onManual);
  }, [controls, onManual, reduced]);
  useEffect(() => () => controls.dispose(), [controls]);
  const target = useRef(new THREE.Vector3(12, 0, 0));
  const desired = useRef(new THREE.Vector3());
  const frame = useMemo(() => {
    const points = view.mapping.nodes.map(n => v3(n.position));
    points.push(v3(view.mapping.explorer.latestPosition ?? [0, 0, 0]));
    const box = new THREE.Box3().setFromPoints(points);
    return { center: box.getCenter(new THREE.Vector3()), size: Math.max(26, box.getSize(new THREE.Vector3()).length() * 0.65) };
  }, [view.mapping]);
  useFrame((_, delta) => {
    if (guided) {
      const island = view.mapping.islands.find(i => i.id === selected);
      const fold = view.mapping.folds.find(f => f.id === selected);
      const focus = island?.lastKnownPosition ?? fold?.lastKnownEntryPosition ?? ((chapter === 2 || chapter === 3) ? view.mapping.folds[0]?.lastKnownEntryPosition : undefined);
      target.current.copy(focus ? v3(focus) : frame.center);
      const tight = !!focus;
      const radius = frame.size;
      desired.current.copy(target.current).add(tight ? new THREE.Vector3(30, 25, 39) : new THREE.Vector3(radius * 1.1, radius * .9, radius * 1.35));
      const speed = reduced ? 1 : 1 - Math.exp(-delta * 1.65);
      camera.position.lerp(desired.current, speed); controls.target.lerp(target.current, speed);
    }
    controls.update();
  });
  return null;
}

function World(props: HologramProps) {
  const { view, selected, onSelect, published = [] } = props;
  const renderer = useThree(s => s.gl);
  const metricsTime = useRef(0);
  useFrame((_, delta) => {
    metricsTime.current += delta;
    if (metricsTime.current >= 1) {
      metricsTime.current = 0;
      renderer.domElement.dataset.renderMetrics = JSON.stringify({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
    }
  });
  const observer = view.mapping.explorer.latestPosition ?? [0, 0, 0];
  const fold = view.temporal.folds[0];
  const forecast = fold?.entry.forecast;
  const evaluated = [...view.temporal.evaluations].reverse().find(e => e.published && e.key === fold?.entry.key && e.issuedAt >= 16);
  const frozen = evaluated && published.find(p => p.key === evaluated.key && p.forecast.issuedAt === evaluated.issuedAt);
  const atmosphere = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#100920'; ctx.fillRect(0, 0, 1024, 768);
    for (let i = 0; i < 32; i++) {
      const x = 300 + Math.sin(i * 7.31) * 360, y = 390 + Math.cos(i * 2.17) * 110;
      const gradient = ctx.createRadialGradient(x,y,0,x,y,180 + i * 2);
      gradient.addColorStop(0, i % 3 ? 'rgba(82,20,130,.055)' : 'rgba(179,63,193,.045)'); gradient.addColorStop(1,'rgba(16,9,32,0)');
      ctx.fillStyle = gradient; ctx.fillRect(0,0,1024,768);
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
  }, []);
  useEffect(() => () => atmosphere.dispose(), [atmosphere]);
  const grid = useMemo(() => { const g = new THREE.GridHelper(150,30,'#623d75','#34213e'); (g.material as THREE.Material).transparent = true; (g.material as THREE.Material).opacity = 0.13; return g; }, []);
  useEffect(() => () => { grid.geometry.dispose(); (grid.material as THREE.Material).dispose(); }, [grid]);
  return <>
    <primitive attach="background" object={atmosphere} />
    <fog attach="fog" args={['#100920', 110, 270]} />
    <ambientLight intensity={1.5} color="#c677b3" />
    <directionalLight position={[10, 35, 20]} intensity={3} color="#f2eaf7" />
    <directionalLight position={[-35, 0, -10]} intensity={4} color="#842c9f" />
    <CameraDirector {...props} />
    <primitive object={grid} position={[0, -12, 0]} />
    {[25, 50, 75].map(r => <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, -11.9, 0]}><ringGeometry args={[r, r + 0.04, 128]} /><meshBasicMaterial color="#842c9f" transparent opacity={0.12} side={THREE.DoubleSide} /></mesh>)}
    <group position={v3(observer)}>
      <mesh><sphereGeometry args={[0.65, 24, 16]} /><meshBasicMaterial color="#f2eaf7" /></mesh>
      <mesh position={[0, -1.5, 0]}><cylinderGeometry args={[0.03, 0.6, 3, 16]} /><meshBasicMaterial color="#e692cb" transparent opacity={0.3} /></mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[4.8, 4.9, 64]} /><meshBasicMaterial color="#e692cb" transparent opacity={0.5} side={THREE.DoubleSide} /></mesh>
      <SignalLabel text="BAYMAX · OBSERVER" position={[0, 0, 0]} offset={-5} />
    </group>
    {view.mapping.islands.map((i, n) => <group key={i.id}>
      <Island id={i.id} position={i.lastKnownPosition} current={i.currentlyObserved} selected={selected === i.id} onSelect={() => onSelect(i.id)} variant={n} showLabel={selected === i.id || (props.chapter !== 2 && props.chapter !== 3 && n < 8)} />
      {i.track.length > 1 && <Trail segments points={i.track.flatMap((p, index) => index > 0 && !p.breakBefore ? [i.track[index - 1]!.position, p.position] : [])} opacity={selected === i.id ? 0.8 : 0.2} />}
    </group>)}
    {view.mapping.folds.map(f => <group key={f.id}>
      <Aperture position={f.lastKnownEntryPosition} ghost={!f.currentlyObserved} selected={selected === f.id} sealed={f.currentlyObserved && (f.currentState === 'closed' || f.currentState === 'inactive')} onClick={() => onSelect(f.id)} />
      <Aperture position={f.lastKnownExitPosition} ghost selected={selected === f.id} onClick={() => onSelect(f.id)} />
      <Trail points={[f.lastKnownEntryPosition, f.lastKnownExitPosition]} dashed opacity={f.currentlyObserved ? 0.27 : 0.12} />
      {(view.mapping.folds.length < 5 || selected === f.id) && <SignalLabel text={`${f.id} · ${f.currentState?.toUpperCase() ?? 'STATE UNKNOWN'}`} position={f.lastKnownEntryPosition} color="#e692cb" />}
      {selected === f.id && <SignalLabel text="REPORTED EXIT · UNVERIFIED" position={f.lastKnownExitPosition} color="#a58bad" />}
      {f.track.length > 1 && <Trail segments points={f.track.flatMap((p, i) => i > 0 && p.time - f.track[i - 1]!.time <= 1.5 && v3(p.entryPosition).distanceTo(v3(f.track[i - 1]!.entryPosition)) < 75 ? [f.track[i - 1]!.entryPosition, p.entryPosition] : [])} color="#f2eaf7" opacity={0.6} />}
      {props.chapter >= 2 && f.track.length > 1 && <Aperture position={f.track[0]!.entryPosition} ghost />}
    </group>)}
    {props.chapter === 3 && forecast && fold?.currentlyObserved && <>
      <Aperture position={forecast.estimate} ghost />
      <Trail points={[fold.entry.observed, forecast.estimate]} dashed color="#f2eaf7" opacity={0.8} />
      <SignalLabel text={`ESTIMATE · t ${forecast.targetTime.toFixed(2)}s`} position={forecast.estimate as WorldVec3} offset={10} />
    </>}
    {props.chapter === 3 && frozen && <>
      <Aperture position={frozen.forecast.estimate} ghost />
      <SignalLabel text={`CHECKED ESTIMATE · t ${frozen.forecast.targetTime.toFixed(2)}s`} position={frozen.forecast.estimate as WorldVec3} color="#c677b3" offset={14} />
    </>}
  </>;
}

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function Hologram(props: HologramProps) {
  const [lost, setLost] = useState(false);
  const fallback = <div className="hologram-fallback"><h2>Spatial records remain available</h2><p>The 3D view is unavailable. Select a recorded entity in the evidence menu to inspect its last-known coordinates.</p></div>;
  return <div className="hologram" aria-label="Interactive 3D holographic map. Drag to orbit, right drag to pan, scroll to zoom.">
    {lost ? fallback : <RenderBoundary fallback={fallback}><Canvas camera={{ position: [70, 55, 75], fov: 40, near: 0.1, far: 10000 }} dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'low-power' }} onCreated={({ gl }) => { gl.domElement.addEventListener('webglcontextlost', () => setLost(true), { once: true }); }}><World {...props} /></Canvas></RenderBoundary>}
  </div>;
}
