import type { MutableRefObject } from 'react';

/** The contract between the ATLAS UI (CommandApp and panels) and the 3D scene (scene/**, camera/**, labels).
 * The UI owns state and layout; the scene owns everything drawn in 3D and the camera. They meet only here and in `SceneProps`. */
export type AtlasView = 'tactical' | 'predict' | 'route';
export type CameraMode = 'overview' | 'follow' | 'focus' | 'prediction' | 'route' | 'interception' | 'manual';
export type SceneQuality = 'cinematic' | 'balanced' | 'performance';

/** Imperative camera commands issued by the UI (buttons, mode changes, selection). The scene resolves them against live state. */
export interface SceneApi {
  /** Elevated three-quarter view of the mapped central region (semantic bounds, not every object). */
  overview(): void;
  /** Follow Baymax's true position with damped tracking; manual orbit temporarily takes over. */
  setFollow(on: boolean): void;
  /** Frame the selected (or given) entity at a distance suited to its size. */
  focus(id: string | null): void;
  /** Frame the selected target, its observed trail and its forecast path. */
  fitPrediction(): void;
  /** Frame Baymax, the destination, the route and the planned meeting together. */
  fitRoute(): void;
  /** Frame the rendezvous event: future Baymax and future target converging. */
  fitInterception(): void;
  /** Current mode, for button state. */
  mode(): CameraMode;
  /** Subscribe to mode changes. */
  onMode(listener: (mode: CameraMode) => void): () => void;
  /** ADDITIVE (optional): leave any tracking mode and hold the camera where it is (the same state an orbit-pan produces). */
  manual?(): void;
  /** ADDITIVE (optional): resolve the mode the current view/selection imply (tactical: overview or focus; predict: prediction; route: route) and apply it. */
  auto?(): void;
  /** ADDITIVE (optional): read-only camera state for tests and status displays. */
  telemetry?(): SceneTelemetry;
}

/** Camera state, separate from the control surface. Positions are world metres. */
export interface SceneTelemetry {
  readonly mode: CameraMode;
  readonly target: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
  /** Distance between the look-at point and Baymax's displayed position (small in follow mode). */
  readonly followError: number;
  /** Seconds since the user last orbited, zoomed or panned. */
  readonly secondsSinceUserInput: number;
}

export type SceneApiRef = MutableRefObject<SceneApi | null>;

/** Presentation options owned by the UI and honoured by the scene. */
export interface ScenePresentation {
  /** Which ATLAS mode is active: it decides what is emphasised and what is dimmed. */
  readonly view: AtlasView;
  /** Show every label (inspection) instead of the tiered default. */
  readonly showAllLabels: boolean;
  /** Subtle spatial reference grid (off by default). */
  readonly showGrid: boolean;
  readonly quality: SceneQuality;
}
