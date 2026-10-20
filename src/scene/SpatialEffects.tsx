import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DodecahedronGeometry, DoubleSide, IcosahedronGeometry, InstancedMesh,
  MeshStandardMaterial, Object3D, PointLight, Quaternion, ShaderMaterial, Vector3,
} from 'three';
import type { FoldConnection } from '../simulation/fractures';
import type { SimulationEngine } from '../simulation/simulationEngine';
import { add, distance, multiply, normalize, scale } from '../simulation/linearAlgebra';
import { createSeededRandom } from '../simulation/seededRandom';
import type { Vec3 } from '../simulation/types';

const Z_AXIS=new Vector3(0,0,1);
const FOLD_COLORS={inactive:'#64728c',forming:'#7c9bff',open:'#78f1e4',unstable:'#ffd18a',closing:'#ff775f',closed:'#776887'};
const EXIT_COLOR='#b49bff';

/** Shared model-time uniform: aperture shimmer freezes when the simulation pauses. */
const modelTime={value:0};

const GLOW_VERTEX=/* glsl */`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const GLOW_FRAGMENT=/* glsl */`
uniform vec3 uColor; uniform float uOpen, uTime;
varying vec2 vUv;
void main(){
  vec2 p=vUv*2.0-1.0; float r=length(p);
  float ring=exp(-pow((r-0.6)/0.05,2.0));
  float halo=exp(-pow((r-0.6)/0.22,2.0));
  float swirl=0.5+0.5*sin(atan(p.y,p.x)*5.0+r*11.0-uTime*1.6);
  float core=(1.0-smoothstep(0.0,0.6,r))*(0.16+0.06*swirl)*uOpen*smoothstep(0.0,0.45,r);
  float a=(ring*0.9+halo*(0.25+0.35*uOpen)+core)*(1.0-smoothstep(0.86,1.0,r));
  gl_FragColor=vec4(uColor*a,a);
}`;

function createGlowMaterial(color:string,open:boolean) {
  return new ShaderMaterial({vertexShader:GLOW_VERTEX,fragmentShader:GLOW_FRAGMENT,transparent:true,depthWrite:false,blending:AdditiveBlending,side:DoubleSide,toneMapped:false,
    uniforms:{uColor:{value:new Color(color)},uOpen:{value:open?1:0.25},uTime:modelTime}});
}

/** Fractured rock rim around an aperture: seeded shards in the aperture's own
 * frame (no independent motion), so the opening reads as torn terrain. */
const SHARD_COUNT=8;
function useShardGeometry() {
  return useMemo(()=>{
    const g=new DodecahedronGeometry(1,1);const p=g.getAttribute('position');const r=createSeededRandom(0x51ab);
    for(let i=0;i<p.count;i++){const k=0.7+r()*0.5;p.setXYZ(i,p.getX(i)*k,p.getY(i)*k*1.6,p.getZ(i)*k*0.7);}
    g.computeVertexNormals();return g;
  },[]);
}

function Aperture({position,normal,color,open,shards,shardMaterial}:{position:Vec3;normal:Vec3;color:string;open:boolean;shards:BufferGeometry;shardMaterial:MeshStandardMaterial}) {
  const rotation=useMemo(()=>new Quaternion().setFromUnitVectors(Z_AXIS,new Vector3(...normal)),[normal]);
  const glow=useMemo(()=>createGlowMaterial(color,open),[color,open]);
  useEffect(()=>()=>glow.dispose(),[glow]);
  const rim=useRef<InstancedMesh>(null);
  useEffect(()=>{
    const mesh=rim.current;if(!mesh)return;const o=new Object3D();const r=createSeededRandom(0x7a11);
    for(let i=0;i<SHARD_COUNT;i++){
      const a=(i/SHARD_COUNT)*Math.PI*2+r()*0.35, radius=1.85+r()*0.45;
      o.position.set(Math.cos(a)*radius,Math.sin(a)*radius,(r()-0.5)*0.5);
      o.rotation.set(r()*3,r()*3,a);o.scale.setScalar(0.08+r()*0.1);o.updateMatrix();mesh.setMatrixAt(i,o.matrix);
    }
    mesh.instanceMatrix.needsUpdate=true;
  },[]);
  return <group position={position} quaternion={rotation}>
    <mesh><torusGeometry args={[1.55,.05,8,64]}/><meshBasicMaterial color={color} toneMapped={false}/></mesh>
    <mesh rotation={[0,0,.35]}><torusGeometry args={[1.82,.014,4,64,Math.PI*1.4]}/><meshBasicMaterial color={color} transparent opacity={.5} toneMapped={false}/></mesh>
    <mesh material={glow} renderOrder={3}><planeGeometry args={[5.2,5.2]}/></mesh>
    <instancedMesh ref={rim} args={[shards,shardMaterial,SHARD_COUNT]} frustumCulled={false}/>
  </group>;
}

function FoldIndicator({connection:c,shards,shardMaterial}:{connection:FoldConnection;shards:BufferGeometry;shardMaterial:MeshStandardMaterial}) {
  const color=FOLD_COLORS[c.state];
  if(!c.valid&&c.state!=='closed')return <mesh position={c.worldPosition}><octahedronGeometry args={[.25,0]}/><meshBasicMaterial color="#7183a8" wireframe transparent opacity={.45}/></mesh>;
  return <group>
    <Aperture position={c.entryWorldPosition} normal={c.entryNormal} color={color} open={c.open} shards={shards} shardMaterial={shardMaterial}/>
    <Aperture position={c.exitWorldPosition} normal={c.exitNormal} color={c.open?EXIT_COLOR:color} open={c.open} shards={shards} shardMaterial={shardMaterial}/>
    <mesh position={c.worldPosition}><octahedronGeometry args={[.17,0]}/><meshBasicMaterial color={color} wireframe/></mesh>
  </group>;
}

const SHELL_VERTEX=/* glsl */`varying vec3 vN; varying vec3 vV; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
const SHELL_FRAGMENT=/* glsl */`uniform vec3 uColor; uniform float uHazard; varying vec3 vN; varying vec3 vV;
void main(){ float f=pow(1.0-abs(dot(normalize(vN),normalize(vV))),3.0); float a=f*(0.05+uHazard*0.42); gl_FragColor=vec4(uColor*a,a); }`;

/** Sampled instability as a soft fresnel shell (front faces only, so it
 * vanishes rather than cluttering the view when the camera is inside). */
function HazardShell({position,hazard}:{position:Vec3;hazard:number}) {
  const material=useMemo(()=>new ShaderMaterial({vertexShader:SHELL_VERTEX,fragmentShader:SHELL_FRAGMENT,transparent:true,depthWrite:false,blending:AdditiveBlending,toneMapped:false,
    uniforms:{uColor:{value:new Color('#f0a65c')},uHazard:{value:0}}}),[]);
  useEffect(()=>()=>material.dispose(),[material]);
  material.uniforms.uHazard!.value=hazard;
  material.uniforms.uColor!.value.set(hazard>.55?'#ff8563':'#f0a65c');
  return <group position={position}>
    <mesh scale={1+hazard*3.5} material={material}><sphereGeometry args={[1,32,16]}/></mesh>
    <mesh><octahedronGeometry args={[.15,0]}/><meshBasicMaterial color="#edb56e" transparent opacity={.25+hazard} toneMapped={false}/></mesh>
  </group>;
}

function GravityProbes({engine}:{engine:SimulationEngine}) {
  const mesh=useRef<InstancedMesh>(null);
  const object=useMemo(()=>new Object3D(),[]);
  const geometry=useMemo(()=>new IcosahedronGeometry(1,0),[]);
  const material=useMemo(()=>new MeshStandardMaterial({color:'#6b5a4a',emissive:'#e3923b',emissiveIntensity:1.1,roughness:.7,flatShading:true}),[]);
  const lines=useMemo(()=>{
    const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float32Array(24),3));return geometry;
  },[]);
  useEffect(()=>()=>{lines.dispose();geometry.dispose();material.dispose();},[lines,geometry,material]);
  useFrame(()=>{
    if(!mesh.current)return;
    const positions=lines.getAttribute('position');
    engine.debris.states.forEach((state,i)=>{
      const s=engine.sampleField(state.referencePosition,engine.clock.time);
      object.position.set(...s.worldPosition);object.scale.setScalar(.16+(i%3)*.04);object.rotation.set(i*1.7,i*2.3,0);object.updateMatrix();
      mesh.current!.setMatrixAt(i,object.matrix);
      if(i<4) {
        const direction=scale(normalize(multiply(s.jacobian,s.gravity)),1.8);
        positions.setXYZ(i*2,...s.worldPosition);positions.setXYZ(i*2+1,...add(s.worldPosition,direction));
      }
    });
    positions.needsUpdate=true;mesh.current.instanceMatrix.needsUpdate=true;
  });
  return <>
    <instancedMesh ref={mesh} name="gravity-probes" args={[geometry,material,12]} frustumCulled={false}/>
    <lineSegments geometry={lines} frustumCulled={false}><lineBasicMaterial color="#ffc584" transparent opacity={.6}/></lineSegments>
  </>;
}

/** Two pooled point lights follow the nearest open aperture pair so fold light
 * falls on surrounding rock. A fixed light count avoids shader recompiles. */
function ApertureLights({connections}:{connections:readonly FoldConnection[]}) {
  const entry=useRef<PointLight>(null), exit=useRef<PointLight>(null);
  const open=connections.find(c=>c.valid&&c.open);
  useEffect(()=>{
    for(const [light,position,color] of [[entry.current,open?.entryWorldPosition,open?FOLD_COLORS[open.state]:null],[exit.current,open?.exitWorldPosition,EXIT_COLOR]] as const) {
      if(!light)continue;
      if(!position||!color){light.intensity=0;continue;}
      light.position.set(...position);light.color.set(color);light.intensity=open!.state==='unstable'?26:34;
    }
  },[open]);
  return <><pointLight ref={entry} intensity={0} distance={22} decay={1.6}/><pointLight ref={exit} intensity={0} distance={22} decay={1.6}/></>;
}

export function SpatialEffects({engine}:{engine:SimulationEngine}) {
  const {camera}=useThree();
  const [connections,setConnections]=useState(()=>engine.network.getConnections(0).filter(c=>c.valid).slice(0,4));
  const [hazards,setHazards]=useState<{position:Vec3;hazard:number}[]>([]);
  const tick=useRef(-1);
  const selectedAt=useRef<Vec3>([Infinity,Infinity,Infinity]);
  const shards=useShardGeometry();
  const shardMaterial=useMemo(()=>new MeshStandardMaterial({color:'#3a3d46',roughness:.9,flatShading:true}),[]);
  useEffect(()=>()=>{shards.dispose();shardMaterial.dispose();},[shards,shardMaterial]);
  useFrame(()=>{
    modelTime.value=engine.clock.time;
    const next=Math.floor(engine.clock.time*4),timeChanged=next!==tick.current;
    const position:Vec3=[camera.position.x,camera.position.y,camera.position.z];
    if(!timeChanged&&distance(position,selectedAt.current)<4)return;
    tick.current=next;selectedAt.current=position;
    setConnections([...engine.network.getConnections(engine.clock.time)].filter(c=>c.valid||c.state==='closed'||c.minSingularValue<.3)
      .sort((a,b)=>distance(position,a.worldPosition)-distance(position,b.worldPosition)).slice(0,4));
    if(timeChanged)setHazards([1,2,4,6].map(i=>{
      const q=add(engine.world.islands[i]!.referencePosition,[0,1.1,0]);const s=engine.sampleField(q,engine.clock.time);
      return {position:s.worldPosition,hazard:s.hazard};
    }));
  });
  return <>
    {connections.map(c=><FoldIndicator key={c.id} connection={c} shards={shards} shardMaterial={shardMaterial}/>)}
    <ApertureLights connections={connections}/>
    {hazards.map((h,i)=><HazardShell key={i} position={h.position} hazard={h.hazard}/>)}
    <GravityProbes engine={engine}/>
  </>;
}
