import type { ReactNode } from 'react';
import type { CommandSession, CommandSnapshot } from '../../session';
import type { SceneApi } from '../../scene/sceneApi';
import type { AtlasView } from '../../scene/sceneApi';
import { timeMarkers } from './logic';
import type { TimeMarker } from './logic';

/** What every mode panel receives. Selection and the scene API are shared; panels never own world state. */
export interface PanelProps {
  readonly snap: CommandSnapshot;
  readonly session: CommandSession;
  readonly scene: () => SceneApi | null;
  readonly setView: (v: AtlasView) => void;
}

export function Kv({ k, v, tone, testId }: { k: string; v: ReactNode; tone?: 'warn' | 'good' | undefined; testId?: string }) {
  return <div className={`kv ${tone ?? ''}`}><dt>{k}</dt><dd data-testid={testId}>{v}</dd></div>;
}

export function Eyebrow({ children }: { children: ReactNode }) { return <p className="eyebrow">{children}</p>; }

export function Evidence({ title = 'Evidence', children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <details className="evidence" data-testid={testId}>
      <summary>{title}</summary>
      <div className="evidence-body">{children}</div>
    </details>
  );
}

/** One horizontal time axis: NOW, the preview, Baymax's ETA, the planned interception and the trusted horizon, all in the same "IN x.x s" language. */
export function TimeRail({ now, opts, testId }: { now: number; opts: Parameters<typeof timeMarkers>[1]; testId?: string }) {
  const markers = timeMarkers(now, opts);
  const end = Math.max(now + 1, ...markers.map(m => m.t));
  const pos = (m: TimeMarker) => (m.t - now) / (end - now);
  return (
    <div className="rail" data-testid={testId} aria-label="Time axis">
      <div className="rail-line" />
      {markers.map((m, i) => {
        const p = pos(m);
        return (
          <div key={`${m.key}-${i}`} className={`rail-mark ${m.key} ${i % 2 ? 'below' : 'above'} ${p > 0.7 ? 'right' : p < 0.2 ? 'left' : ''}`} style={{ left: `${(p * 100).toFixed(2)}%` }}>
            <i />
            <span>{m.label}</span>
          </div>
        );
      })}
    </div>
  );
}
