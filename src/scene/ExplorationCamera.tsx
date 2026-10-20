import { useCallback, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { HUD_UPDATE_INTERVAL_SECONDS } from '../simulation/constants';
import type { SimulationEngine } from '../simulation/simulationEngine';
import type { SimulationTelemetry } from './sceneTypes';
import { collectTelemetry } from './telemetry';
import { attachDiagnostics } from './diagnostics';
import { VIEWPOINTS, viewpointPose } from './cinematicViews';
import type { Vec3 } from '../simulation/types';

interface ExplorationCameraProps {
  readonly engine: SimulationEngine;
  readonly onTelemetry: (telemetry: SimulationTelemetry) => void;
  readonly resetVersion: number;
}

const LOOK_SENSITIVITY = 0.0025;
const BASE_SPEED = 14;
const BOOST_MULTIPLIER = 3;

export function ExplorationCamera({ engine, onTelemetry, resetVersion }: ExplorationCameraProps) {
  const { camera, gl, scene } = useThree();
  const keys = useRef(new Set<string>());
  const yaw = useRef(0);
  const pitch = useRef(0);
  const drag = useRef<{ active: boolean; pointerId: number; x: number; y: number }>({
    active: false,
    pointerId: -1,
    x: 0,
    y: 0,
  });
  const telemetryTimer = useRef(0);
  const forward = useRef(new Vector3());
  const right = useRef(new Vector3());
  const movement = useRef(new Vector3());
  const worldUp = useRef(new Vector3(0, 1, 0));
  const enterRequested=useRef(false);
  const appliedReset=useRef(engine.resetRevision);

  const frame=useCallback((position:Vec3,lookTarget:Vec3)=>{
    const target = new Vector3(...lookTarget);
    camera.position.set(...position);
    camera.lookAt(target);
    const direction = target.sub(camera.position).normalize();
    yaw.current = Math.atan2(-direction.x, -direction.z);
    pitch.current = Math.asin(direction.y);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(pitch.current, yaw.current, 0, 'YXZ');
  },[camera]);
  const resetOpening=useCallback(()=>{
    engine.explorer.reset(engine.clock.time,false);
    const pose=engine.explorer.pose(engine.clock.time);
    frame(pose.position,pose.target);
  },[engine,frame]);
  useEffect(()=>resetOpening(),[resetOpening,resetVersion]);
  useEffect(()=>attachDiagnostics(engine,camera,scene),[engine,camera,scene]);

  useEffect(() => {
    const element = gl.domElement;
    element.tabIndex=0;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag.current = { active: true, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      element.focus({ preventScroll: true });
      element.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - state.x;
      const deltaY = event.clientY - state.y;
      state.x = event.clientX;
      state.y = event.clientY;
      yaw.current -= deltaX * LOOK_SENSITIVITY;
      pitch.current = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, pitch.current - deltaY * LOOK_SENSITIVITY));
      camera.rotation.set(pitch.current, yaw.current, 0, 'YXZ');
    };
    const finishDrag = (event: PointerEvent) => {
      if (drag.current.pointerId !== event.pointerId) return;
      drag.current.active = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, input, select, textarea')) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        event.preventDefault();
        keys.current.add(event.code);
      }
      if (event.code === 'KeyR' && !event.repeat) {
        resetOpening();
      }
      if(event.code==='KeyE'&&!event.repeat){event.preventDefault();enterRequested.current=true;}
      // Rendering-only framings; flight continues normally from the new pose.
      const view=/^Digit([1-9])$/.exec(event.code);
      if(view&&!event.repeat){const pose=viewpointPose(VIEWPOINTS[Number(view[1])-1]!,engine);frame(pose.position,pose.target);}
    };
    const onKeyUp = (event: KeyboardEvent) => { keys.current.delete(event.code); };
    const onBlur = () => { keys.current.clear(); drag.current.active = false; };
    const onEscape = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      drag.current.active = false;
      if (drag.current.pointerId !== -1 && element.hasPointerCapture(drag.current.pointerId)) {
        element.releasePointerCapture(drag.current.pointerId);
      }
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', finishDrag);
    element.addEventListener('pointercancel', finishDrag);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onEscape);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', finishDrag);
      element.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onEscape);
    };
  }, [camera, gl, resetOpening, engine, frame]);

  useFrame((_, delta) => {
    engine.advance(delta);
    if(appliedReset.current!==engine.resetRevision){appliedReset.current=engine.resetRevision;resetOpening();}
    const step = Math.min(delta, 0.05);
    const pressed = keys.current;

    if (step > 0) {
      camera.getWorldDirection(forward.current);
      right.current.crossVectors(forward.current, worldUp.current).normalize();
      movement.current.set(0, 0, 0);

      const forwardInput = Number(pressed.has('KeyW')) - Number(pressed.has('KeyS'));
      const sideInput = Number(pressed.has('KeyD')) - Number(pressed.has('KeyA'));
      const verticalInput = Number(pressed.has('Space'))
        - Number(pressed.has('ControlLeft') || pressed.has('ControlRight'));
      movement.current.addScaledVector(forward.current, forwardInput);
      movement.current.addScaledVector(right.current, sideInput);
      movement.current.y += verticalInput;

      if (movement.current.lengthSq() > 0) {
        const speed = BASE_SPEED * (pressed.has('ShiftLeft') || pressed.has('ShiftRight') ? BOOST_MULTIPLIER : 1);
        camera.position.addScaledVector(movement.current.normalize(), speed * step);
      }
    }

    engine.explorer.updateWorld([camera.position.x,camera.position.y,camera.position.z],engine.clock.time);
    if(enterRequested.current) {
      enterRequested.current=false;
      const traversal=engine.explorer.traverse(engine.clock.time);
      if(traversal.accepted){camera.position.set(...engine.explorer.worldPosition);telemetryTimer.current=HUD_UPDATE_INTERVAL_SECONDS;}
    }
    const p=engine.performance;
    p.frames.push(delta*1000);if(p.frames.length>1800)p.frames.shift();
    p.drawCalls=gl.info.render.calls;p.triangles=gl.info.render.triangles;p.geometries=gl.info.memory.geometries;p.textures=gl.info.memory.textures;
    p.detectionMs=engine.network.detectionMilliseconds;p.graphMs=engine.network.graphMilliseconds;

    telemetryTimer.current += Math.min(delta, 0.1);
    if (telemetryTimer.current < HUD_UPDATE_INTERVAL_SECONDS) return;
    telemetryTimer.current %= HUD_UPDATE_INTERVAL_SECONDS;

    onTelemetry(collectTelemetry(engine));
  }, -2);

  return null;
}
