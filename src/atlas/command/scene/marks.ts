import { Vector3 } from 'three';

/** Annotations the scene wants drawn as labels (forecast ghosts, "capsule now", the planned rendezvous...). The scene fills a preallocated pool every
 * frame and the label layer (ui/Labels.tsx) places them with the entity labels, under one priority and collision policy. */
export type MarkTone = 'baymax' | 'target' | 'ghost' | 'rendezvous' | 'warning' | 'info' | 'frozen';
export interface LabelMark {
  key: string;
  text: string;
  sub: string;
  tone: MarkTone;
  /** 1 = always shown when relevant; 2 = by zoom/relevance. */
  tier: 1 | 2;
  readonly at: Vector3;
  /** Entity this mark describes (clicking selects it), if any. */
  entityId: string | null;
}

export class MarkPool {
  readonly items: LabelMark[] = [];
  count = 0;
  begin(): void { this.count = 0; }
  add(key: string, text: string, sub: string, tone: MarkTone, tier: 1 | 2, x: number, y: number, z: number, entityId: string | null = null): void {
    let m = this.items[this.count];
    if (!m) { m = { key, text, sub, tone, tier, at: new Vector3(), entityId }; this.items.push(m); }
    m.key = key; m.text = text; m.sub = sub; m.tone = tone; m.tier = tier; m.entityId = entityId; m.at.set(x, y, z);
    this.count += 1;
  }
}
