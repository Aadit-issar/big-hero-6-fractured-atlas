import type { MutableRefObject } from 'react';
import type { PerspectiveCamera, Vector3 } from 'three';
import type { CommandSession, CommandSnapshot } from '../session';
import type { MarkPool } from './marks';
import type { SceneApiRef, ScenePresentation } from './sceneApi';

/** Where things are drawn, shared by the scene (writer) and the label layer / camera (readers). The first five fields are the original contract; the rest
 * are optional additions the scene fills in. */
export interface DisplayAnchors {
  baymax: Vector3;
  entities: Map<string, Vector3>;
  meeting: Vector3 | null;
  ghost: Vector3 | null;
  /** Camera distance, used to scale small objects for legibility. */
  scale: number;
  /** Visual radius (world units, after legibility scaling) per entity id. */
  extents?: Map<string, number>;
  baymaxYaw?: number;
  baymaxExtent?: number;
  baymaxVisible?: boolean;
  /** Entity under the pointer. */
  hoverId?: string | null;
  /** Annotations produced by the scene (ghost times, rendezvous, target now...). */
  marks?: MarkPool;
  /** Current camera mode and the presentation the scene is honouring (for the label budget). */
  mode?: import('./sceneApi').CameraMode;
  presentation?: ScenePresentation;
}

export interface SceneProps {
  readonly snapshotRef: MutableRefObject<CommandSnapshot>;
  readonly session: CommandSession;
  readonly follow: boolean;
  readonly focusNonce: number;
  readonly focusId: string | null;
  readonly onManual: () => void;
  readonly onSelect: (id: string | null) => void;
  readonly cameraRef: MutableRefObject<PerspectiveCamera | null>;
  readonly anchorsRef: MutableRefObject<DisplayAnchors>;
  readonly base: string;
  readonly view: 'tactical' | 'predict' | 'route';
  /** Presentation options from the UI (labels, grid, quality) and the imperative camera API the scene fills in. */
  readonly presentation?: ScenePresentation;
  readonly apiRef?: SceneApiRef;
  /** Render-rate cap (frames per second). The tactical map is a monitor, not the game: it leaves the GPU to the Dimension. */
  readonly fps: number;
}
