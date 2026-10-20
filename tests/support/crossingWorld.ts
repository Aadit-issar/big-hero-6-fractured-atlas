import { LiveWorld } from './liveWorld';
import type { Vec3 } from '../../src/atlas/command/world';

/** AUTHORED scenario (not the Dimension's own dynamics): a capsule crossing Baymax's line of approach at constant velocity, produced through the SAME frame
 * pipeline as the real world (scans with label, attitude and radius, no velocity). It exists to measure the strategies where prediction matters most:
 * a target that moves across the path while Baymax is only modestly faster. It is labelled as authored everywhere it is reported. */
export class CrossingWorld extends LiveWorld {
  constructor(readonly origin: Vec3, readonly velocity: Vec3) { super('closed-loop', 'cruise'); }
  private at(t: number): Vec3 { return [this.origin[0] + this.velocity[0] * t, this.origin[1] + this.velocity[1] * t, this.origin[2] + this.velocity[2] * t]; }
  override truth(id: string): Vec3 { return id === 'capsule-abigail' ? this.at(this.time) : super.truth(id); }
  override truthAt(id: string, t: number): Vec3 { return id === 'capsule-abigail' ? this.at(t) : super.truthAt(id, t); }
  override frame(withScan: boolean, range = 60) {
    const f = super.frame(withScan, range);
    if (!f.scan) return { ...f, observation: { ...f.observation, islands: [], connections: [] } };
    const p = this.at(this.time);
    const r = Math.hypot(p[0] - this.baymax[0], p[1] - this.baymax[1], p[2] - this.baymax[2]);
    const objects = f.scan.objects.filter(o => o.id !== 'capsule-abigail');
    if (r <= 100) objects.push({ id: 'capsule-abigail', category: 'landmark', family: 'capsule', kind: 'capsule_shell_remnant', label: "Abigail's Capsule", orientation: [0, 0, 0, 1], position: p, radius: 2.4, range: r });
    // An empty sky: the comparison isolates the effect of prediction (the real islands would favour the strategy that ignores clearance).
    return { ...f, observation: { ...f.observation, islands: [], connections: [] }, scan: { ...f.scan, objects } };
  }
}
