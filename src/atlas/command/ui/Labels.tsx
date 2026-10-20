import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { readInsets } from '../camera/insets';
import type { CommandSnapshot } from '../session';
import type { DisplayAnchors } from '../scene/types';
import type { ScenePresentation } from '../scene/sceneApi';
import { layoutLabels } from './labels/layout';
import type { LayoutInput, Rect, Side } from './labels/layout';
import { classify, labelBudget } from './labels/policy';
import './labels/labels.css';

/** Screen-space labels for the tactical scene: three tiers, a per-mode budget, collision avoidance against each other, Baymax's body, the selected
 * object and the UI panels (read from the DOM), sticky sides so placement does not jitter, and a hover card for details. A tag is a button (selects
 * its object). Positions are written straight to the DOM at ~30 Hz. */
const H = 24;
const TICK_MS = 33;

interface Slot { measured: boolean; el: HTMLButtonElement; title: HTMLElement; sub: HTMLElement; w: number; text: string; subText: string; cls: string; x: number; y: number; shown: boolean; lastUsed: number }
interface Cand { key: string; text: string; sub: string; tone: string; glyph: string; entityId: string | null; clickable: boolean; ax: number; ay: number; radius: number; priority: number; tier: 1 | 2 | 3; cls: string }

const GLYPH: Record<string, string> = { island: 'hex', fold: 'bolt', capsule: 'diamond', equipment: 'diamond', debris: 'dot', wreckage: 'dot', swarm: 'dot' };
const shortLabel = (s: string) => s.replace(/^Floating /i, '').toUpperCase();

export function Labels({ snapshotRef, anchorsRef, cameraRef, onSelect, presentation }: {
  readonly snapshotRef: MutableRefObject<CommandSnapshot>; readonly anchorsRef: MutableRefObject<DisplayAnchors>; readonly cameraRef: MutableRefObject<PerspectiveCamera | null>;
  readonly onSelect: (id: string) => void; readonly presentation?: ScenePresentation;
}) {
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ onSelect, presentation }); propsRef.current = { onSelect, presentation };

  useEffect(() => {
    const container = host.current!;
    const slots = new Map<string, Slot>();
    const sides = new Map<string, Side>();
    const v = new Vector3();
    let raf = 0, last = 0, hoverKey = '';

    const slotFor = (key: string): Slot => {
      let s = slots.get(key);
      if (!s) {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'lbl'; el.style.display = 'none';
        const glyph = document.createElement('i'); glyph.className = 'g';
        const title = document.createElement('b'), sub = document.createElement('small');
        el.append(glyph, title, sub);
        el.addEventListener('click', () => { const id = el.dataset.id; if (id) propsRef.current.onSelect(id); });
        container.appendChild(el);
        s = { measured: false, el, title, sub, w: 120, text: '', subText: '', cls: '', x: 0, y: 0, shown: false, lastUsed: 0 };
        slots.set(key, s);
      }
      return s;
    };

    const project = (p: Vector3, cam: PerspectiveCamera, W: number, Hh: number): { x: number; y: number } | null => {
      v.copy(p).project(cam);
      if (v.z > 1 || v.z < -1) return null;
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * Hh };
    };

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < TICK_MS) return;
      last = t;
      const cam = cameraRef.current, snap = snapshotRef.current, a = anchorsRef.current;
      if (!cam) return;
      const pres = propsRef.current.presentation ?? a.presentation ?? { view: 'tactical', showAllLabels: false, showGrid: false, quality: 'balanced' } as ScenePresentation;
      const W = window.innerWidth, Hh = window.innerHeight;
      const ins = readInsets(W, Hh);
      const free: Rect = { x: ins.left + 4, y: ins.top + 4, w: W - ins.left - ins.right - 8, h: Hh - ins.top - ins.bottom - 36 };
      const focusActive = pres.view !== 'tactical' && !!snap.selectedId;
      const pxPerM = Hh / (2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(1, a.scale));
      const cands: Cand[] = [];
      const obstacles: Rect[] = [];
      const extents = a.extents;

      // Baymax: always. His body is an obstacle for every other tag.
      if (snap.pose && a.baymaxVisible !== false) {
        const r = Math.max(10, (a.baymaxExtent ?? 2) * pxPerM * 1.6);
        v.copy(a.baymax); const bp = project(v, cam, W, Hh);
        if (bp) {
          obstacles.push({ x: bp.x - r, y: bp.y - r, w: 2 * r, h: 2 * r });
          const speed = Math.hypot(snap.pose.velocity[0], snap.pose.velocity[1], snap.pose.velocity[2]);
          cands.push({ key: 'baymax', text: 'BAYMAX', sub: speed > 0.3 ? `${speed.toFixed(0)} m/s` : 'hover', tone: 'baymax', glyph: 'ring', entityId: null, clickable: false, ax: bp.x, ay: bp.y, radius: r, priority: 990, tier: 1, cls: '' });
        }
      }

      // Scene annotations: forecast times, target now, rendezvous / aim point, approach point.
      const marks = a.marks;
      const markEntities = new Set<string>();
      if (marks) for (let i = 0; i < marks.count; i += 1) {
        const m = marks.items[i]!;
        const p = project(m.at, cam, W, Hh); if (!p) continue;
        if (m.entityId) markEntities.add(m.entityId);
        const pr = m.tone === 'rendezvous' || m.tone === 'warning' ? 985 : m.tone === 'target' ? 960 : m.tone === 'baymax' ? 700 : m.tier === 1 ? 950 : 620;
        cands.push({ key: `mark:${m.key}`, text: m.text, sub: m.sub, tone: m.tone, glyph: m.tone === 'rendezvous' ? 'cross' : m.tone === 'warning' ? 'tri' : m.tone === 'ghost' ? 'ring' : m.tone === 'target' ? 'diamond' : m.tone === 'baymax' ? 'ring' : 'dot', entityId: m.entityId, clickable: !!m.entityId, ax: p.x, ay: p.y, radius: m.tone === 'target' ? 18 : 6, priority: pr, tier: m.tier, cls: '' });
      }

      // Entities.
      const objective = snap.route.command && (snap.route.state === 'accepted' || snap.route.state === 'sent') ? snap.route.command.goal.id : pres.view === 'route' ? snap.plan?.targetId ?? null : null;
      const obstacleIds = snap.plan?.obstacles ?? [];
      let hidden = 0;
      for (const e of snap.entities) {
        if (e.kind === 'swarm') continue;
        const pos = a.entities.get(e.id); if (!pos) continue;
        const selected = snap.selectedId === e.id;
        const dist = pos.distanceTo(a.baymax);
        const pol = classify({ kind: e.kind, remembered: e.knowledge !== 'current', moving: snap.estimates.get(e.id)?.motion === 'moving', foldState: e.foldState, selected, objective: objective === e.id, related: obstacleIds.includes(e.id), distance: dist }, focusActive, pres.showAllLabels);
        if (!pol) { if (e.kind !== 'island' && e.kind !== 'fold' && e.kind !== 'capsule' && e.kind !== 'equipment') hidden += 1; continue; }
        const p = project(pos, cam, W, Hh); if (!p) continue;
        const ext = Math.max(8, (extents?.get(e.id) ?? e.radius) * pxPerM);
        if (selected || e.id === objective) obstacles.push({ x: p.x - ext, y: p.y - ext, w: 2 * ext, h: 2 * ext });
        if (markEntities.has(e.id)) continue; // a scene annotation already names it ("CAPSULE NOW")
        const est = snap.estimates.get(e.id);
        const moving = est?.motion === 'moving' && e.kind !== 'island' && e.kind !== 'fold';
        const sub = e.knowledge === 'current' ? (e.kind === 'fold' ? (e.foldState ?? '') : moving ? 'moving' : '') : `last known ${Math.max(0, snap.simTime - e.lastSeen).toFixed(0)} s`;
        cands.push({ key: e.id, text: shortLabel(e.label), sub, tone: e.knowledge === 'current' ? (e.kind === 'fold' && e.foldState === 'unstable' ? 'warning' : selected ? 'target' : 'info') : 'frozen', glyph: GLYPH[e.kind] ?? 'dot', entityId: e.id, clickable: true, ax: p.x, ay: p.y, radius: Math.min(60, ext), priority: pol.priority + (slots.get(e.id)?.shown ? 70 : 0), tier: pol.tier, cls: `${selected ? 'sel ' : ''}${e.knowledge === 'current' ? '' : 'mem '}k-${e.kind}` });
      }

      // Measure and place.
      const items: LayoutInput[] = cands.map(c => {
        const s = slots.get(c.key);
        const w = s && s.text === c.text && s.subText === c.sub ? s.w : 36 + c.text.length * 8.2 + (c.sub ? 14 + c.sub.length * 6.4 : 0);
        return { key: c.key, priority: c.priority, tier: c.tier, ax: c.ax, ay: c.ay, radius: c.radius, w, h: H };
      });
      const placed = layoutLabels(items, free, obstacles, labelBudget(a.mode, a.scale, pres.showAllLabels), sides);
      const now = t;
      const used = new Set<string>();
      const byKey = new Map<string, Cand>(); for (const c of cands) byKey.set(c.key, c);
      for (const p of placed) {
        const c = byKey.get(p.key)!; used.add(p.key); sides.set(p.key, p.side);
        const s = slotFor(p.key);
        if (s.text !== c.text || s.subText !== c.sub || s.cls !== `${c.tone} ${c.glyph} ${c.cls}`) {
          s.text = c.text; s.subText = c.sub; s.cls = `${c.tone} ${c.glyph} ${c.cls}`;
          s.el.className = `lbl t-${c.tone} g-${c.glyph} s-${p.side} tier${c.tier} ${c.cls}${c.clickable ? '' : ' static'}`;
          if (s.shown) s.el.classList.add('on');
          s.title.textContent = c.text; s.sub.textContent = c.sub; s.sub.style.display = c.sub ? '' : 'none';
          s.el.dataset.id = c.entityId ?? ''; s.el.dataset.key = c.key;
          s.measured = false;
        } else if (!s.el.classList.contains(`s-${p.side}`)) {
          s.el.classList.remove('s-top', 's-bottom', 's-left', 's-right'); s.el.classList.add(`s-${p.side}`);
        }
        const k = s.shown ? 0.45 : 1;
        if (Math.hypot(p.x - s.x, p.y - s.y) > 90) { s.x = p.x; s.y = p.y; } else { s.x += (p.x - s.x) * k; s.y += (p.y - s.y) * k; }
        s.el.style.transform = `translate(${s.x.toFixed(1)}px, ${Math.max(free.y, s.y).toFixed(1)}px)`;
        if (!s.shown) { s.el.style.display = ''; requestAnimationFrame(() => s.el.classList.add('on')); s.shown = true; }
        if (!s.measured && s.shown && s.el.style.display !== 'none') { const w = s.el.offsetWidth; if (w > 20) { s.w = w; s.measured = true; } }
        s.lastUsed = now;
      }
      for (const [key, s] of slots) {
        if (used.has(key)) continue;
        if (s.shown) { s.shown = false; s.el.classList.remove('on'); }
        if (now - s.lastUsed > 400 && s.el.style.display !== 'none') s.el.style.display = 'none';
        if (now - s.lastUsed > 60000) { s.el.remove(); slots.delete(key); sides.delete(key); }
      }

      // Aggregated tier 3.
      const m = more.current;
      if (m) {
        const show = !pres.showAllLabels && hidden > 0 && !focusActive;
        m.style.display = show ? '' : 'none';
        if (show) { m.textContent = `+${hidden} small objects not labelled`; m.style.left = `${free.x + free.w / 2}px`; m.style.top = `${free.y + free.h + 8}px`; }
      }

      // Hover card.
      const c = card.current;
      if (c) {
        const hid = a.hoverId ?? null;
        const e = hid ? snap.entities.find(x => x.id === hid) : null;
        const pos = hid ? a.entities.get(hid) : null;
        const p = e && pos ? project(pos, cam, W, Hh) : null;
        if (!e || !p) { c.style.display = 'none'; hoverKey = ''; }
        else {
          const est = snap.estimates.get(e.id);
          const key = `${e.id}|${e.knowledge}|${est?.motion}|${Math.round(pos!.distanceTo(a.baymax))}|${e.foldState}`;
          if (key !== hoverKey) {
            hoverKey = key;
            const lines = [`${e.kind.toUpperCase()} · ${e.knowledge === 'current' ? 'observed now' : `last seen ${Math.max(0, snap.simTime - e.lastSeen).toFixed(0)} s ago`}`, `${pos!.distanceTo(a.baymax).toFixed(0)} m from Baymax`];
            if (est?.motion === 'moving') lines.push('moving: forecast available');
            if (e.foldState) lines.push(`fold ${e.foldState}; destination unverified`);
            c.replaceChildren();
            const h = document.createElement('b'); h.textContent = e.label; c.appendChild(h);
            for (const l of lines) { const d = document.createElement('span'); d.textContent = l; c.appendChild(d); }
          }
          c.style.display = '';
          const cw = c.offsetWidth || 200, ch = c.offsetHeight || 70;
          const ext = Math.max(10, (extents?.get(e.id) ?? e.radius) * pxPerM);
          const x = Math.min(free.x + free.w - cw, Math.max(free.x, p.x + ext + 12)), y = Math.min(free.y + free.h - ch, Math.max(free.y, p.y - ch / 2));
          c.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); for (const s of slots.values()) s.el.remove(); slots.clear(); };
  }, [snapshotRef, anchorsRef, cameraRef]);

  return (
    <div className="cmd-labels" ref={host} data-testid="labels">
      <div className="lbl-card" ref={card} style={{ display: 'none' }} />
      <div className="lbl-more" ref={more} style={{ display: 'none' }} />
    </div>
  );
}
