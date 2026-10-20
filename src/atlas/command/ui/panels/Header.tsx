import { useState } from 'react';
import type { CommandSession, CommandSnapshot } from '../../session';
import type { AtlasView, SceneQuality } from '../../scene/sceneApi';
import { connectionPill } from './logic';

export const MODES: readonly { readonly id: AtlasView; readonly label: string; readonly purpose: string }[] = [
  { id: 'tactical', label: 'Tactical map', purpose: 'What exists?' },
  { id: 'predict', label: 'Predictive analysis', purpose: 'Where will it go?' },
  { id: 'route', label: 'Route planning', purpose: 'Where must Baymax go, and why?' },
];
const QUALITY: readonly SceneQuality[] = ['performance', 'balanced', 'cinematic'];

export interface HeaderProps {
  readonly snap: CommandSnapshot;
  readonly session: CommandSession;
  readonly view: AtlasView;
  readonly setView: (v: AtlasView) => void;
  readonly follow: boolean;
  readonly onFollow: () => void;
  readonly onOverview: () => void;
  readonly onFit: () => void;
  readonly fitLabel: string | null;
  readonly eco: boolean;
  readonly setEco: (v: boolean) => void;
  readonly labels: boolean;
  readonly setLabels: (v: boolean) => void;
  readonly quality: SceneQuality;
  readonly setQuality: (q: SceneQuality) => void;
}

export function Header(p: HeaderProps) {
  const { snap, session } = p;
  const pill = connectionPill(snap);
  const [diag, setDiag] = useState(false);
  const c = snap.link.counters;
  return (
    <header className="top">
      <div className="brand"><span>ATLAS</span><em>COMMAND</em></div>
      <nav className="modes" aria-label="Modes" role="tablist">
        {MODES.map(m => (
          <button key={m.id} type="button" role="tab" aria-selected={p.view === m.id} className={p.view === m.id ? 'on' : ''} title={m.purpose} onClick={() => p.setView(m.id)} data-testid={`tab-${m.id}`}>
            <span>{m.label}</span><small>{m.purpose}</small>
          </button>
        ))}
      </nav>
      <div className="pillstatus" data-testid="link-status" data-tone={pill.tone} title="Link to the running Dimension">
        <i className={`dot ${pill.tone}`} /><b>{pill.text}</b><span>{pill.detail}</span>
      </div>
      <div className="acts">
        <button type="button" className="primary" disabled={!snap.connected || snap.scanPending} onClick={() => session.requestScan()} data-testid="scan">{snap.scanPending ? 'Scanning…' : 'Scan'}</button>
        <button type="button" className={p.follow ? 'on' : ''} onClick={p.onFollow} aria-pressed={p.follow} data-testid="follow">Follow Baymax</button>
        <button type="button" onClick={p.onOverview} data-testid="overview">Overview</button>
        {p.fitLabel && <button type="button" onClick={p.onFit} data-testid="fit">{p.fitLabel}</button>}
        <span className="sep" />
        <select className="quality" value={p.quality} onChange={e => p.setQuality(e.target.value as SceneQuality)} aria-label="Map quality" data-testid="quality">
          {QUALITY.map(q => <option key={q} value={q}>{q[0]!.toUpperCase() + q.slice(1)}</option>)}
        </select>
        <button type="button" className={p.eco ? 'on' : ''} onClick={() => p.setEco(!p.eco)} aria-pressed={p.eco} title="Render the map at 12 frames per second to leave the GPU to the Dimension" data-testid="eco">Eco</button>
        <div className="diag-wrap">
          <button type="button" className={`icon ${diag ? 'on' : ''}`} onClick={() => setDiag(d => !d)} aria-expanded={diag} aria-label="Diagnostics" title="Diagnostics" data-testid="diagnostics-toggle">{'⋯'}</button>
          {diag && (
            <div className="popover" role="dialog" aria-label="Diagnostics" data-testid="diagnostics">
              <h3>Diagnostics</h3>
              <dl>
                <dt>Dimension session</dt><dd>{snap.link.session ? snap.link.session.slice(0, 8) : 'none'}</dd>
                <dt>Episode</dt><dd>{snap.episode}</dd>
                <dt>Origin</dt><dd>{snap.link.dimensionOrigin ?? '—'}</dd>
                <dt>Frames accepted</dt><dd>{c.accepted}</dd>
                <dt>Duplicates / foreign / malformed / bad origin</dt><dd>{c.duplicate} / {c.foreignSession} / {c.malformed} / {c.badOrigin}</dd>
                <dt>Objects in memory</dt><dd>{snap.entities.length}</dd>
                <dt>Scan range / mode</dt><dd>{snap.link.scanRange ?? '—'} m / {snap.link.scanMode ?? '—'}</dd>
              </dl>
              <label className="check"><input type="checkbox" checked={p.labels} onChange={e => p.setLabels(e.target.checked)} /> Show every label on the map</label>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => { if (snap.connected) session.disconnect(); else session.reconnect(); setDiag(false); }} data-testid="reconnect">{snap.connected ? 'Disconnect' : 'Reconnect'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
