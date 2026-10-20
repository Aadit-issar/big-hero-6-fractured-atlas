import { Color, Group } from 'three';
import type { InterleavedBufferAttribute } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/** A luminous path: a soft wide halo under a crisp core, both fat lines (screen-space width) sharing one geometry that is updated IN PLACE (no allocation
 * after construction). Dashes are measured in world metres: the cumulative distance along the polyline is written into the geometry's own
 * line-distance attributes, so the dash length does not change with zoom or segment length. */
const CAPACITY = 160;

export interface PathStyle { readonly color: string; readonly width: number; readonly opacity: number; readonly halo?: number; readonly haloOpacity?: number; readonly dash?: readonly [number, number]; readonly depthTest?: boolean }

export class PathLine {
  readonly root = new Group();
  private readonly geometry = new LineGeometry();
  private readonly core: Line2;
  private readonly halo: Line2 | null;
  private readonly segments: Float32Array;
  private readonly distances: Float32Array;
  private readonly materials: LineMaterial[] = [];
  length = 0;

  constructor(style: PathStyle) {
    this.geometry.setPositions(new Float32Array((CAPACITY + 1) * 3));
    const mk = (width: number, opacity: number, color: string) => {
      const m = new LineMaterial({ color: new Color(color).getHex(), linewidth: width, transparent: true, opacity, depthWrite: false, depthTest: style.depthTest ?? true, worldUnits: false });
      if (style.dash) { m.dashed = true; m.dashSize = style.dash[0]; m.gapSize = style.dash[1]; m.dashScale = 1; }
      this.materials.push(m);
      return m;
    };
    this.core = new Line2(this.geometry, mk(style.width, style.opacity, style.color));
    this.core.computeLineDistances();
    this.core.frustumCulled = false; this.core.renderOrder = 6;
    this.halo = style.halo ? new Line2(this.geometry, mk(style.halo, style.haloOpacity ?? 0.16, style.color)) : null;
    if (this.halo) { this.halo.frustumCulled = false; this.halo.renderOrder = 5; this.root.add(this.halo); }
    this.root.add(this.core);
    this.segments = (this.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).data.array as Float32Array;
    this.distances = (this.geometry.getAttribute('instanceDistanceStart') as InterleavedBufferAttribute).data.array as Float32Array;
    this.root.visible = false;
  }

  /** Writes up to CAPACITY+1 points (x,y,z triples via `get`). Hides the line with fewer than two points. */
  set(count: number, get: (i: number, out: [number, number, number]) => void): void {
    const n = Math.min(count, CAPACITY + 1);
    if (n < 2) { this.root.visible = false; this.length = 0; return; }
    const a: [number, number, number] = [0, 0, 0];
    let px = 0, py = 0, pz = 0, d = 0;
    for (let i = 0; i < n; i += 1) {
      get(i, a);
      if (i > 0) {
        const s = i - 1;
        this.segments[s * 6] = px; this.segments[s * 6 + 1] = py; this.segments[s * 6 + 2] = pz;
        this.segments[s * 6 + 3] = a[0]; this.segments[s * 6 + 4] = a[1]; this.segments[s * 6 + 5] = a[2];
        this.distances[s * 2] = d; d += Math.hypot(a[0] - px, a[1] - py, a[2] - pz); this.distances[s * 2 + 1] = d;
      }
      px = a[0]; py = a[1]; pz = a[2];
    }
    const attr = this.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
    attr.data.needsUpdate = true;
    (this.geometry.getAttribute('instanceDistanceStart') as InterleavedBufferAttribute).data.needsUpdate = true;
    this.geometry.instanceCount = n - 1;
    this.length = d;
    this.root.visible = true;
  }

  hide(): void { this.root.visible = false; this.length = 0; }
  setOpacity(core: number): void { this.materials[0]!.opacity = core; if (this.materials[1]) this.materials[1].opacity = core * 0.2; }
  setResolution(w: number, h: number): void { for (const m of this.materials) m.resolution.set(w, h); }
  dispose(): void { this.geometry.dispose(); for (const m of this.materials) m.dispose(); }
}
