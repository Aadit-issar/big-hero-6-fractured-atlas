import type { PanelProps } from './common';
import { Eyebrow, Kv } from './common';
import { dist, f0, f1, planBadge, vec } from './logic';

/** Tactical map: "what exists?". Coverage, the Scan action, and a small card for the selected object with exactly one next action. */
export function TacticalPanel({ snap, session, setView, scene }: PanelProps) {
  const target = snap.selectedId ? snap.targets.find(t => t.id === snap.selectedId) ?? null : null;
  const bay = snap.pose?.position ?? null;
  const current = snap.entities.filter(e => e.kind !== 'swarm' && e.knowledge === 'current').length;
  const remembered = snap.entities.filter(e => e.kind !== 'swarm' && e.knowledge === 'remembered').length;
  const total = current + remembered;
  const count = (k: string) => snap.entities.filter(e => e.kind === k).length;

  if (!target) {
    return (
      <section className="card" data-testid="panel-tactical">
        <Eyebrow>Tactical map</Eyebrow>
        <h2>What is out there?</h2>
        <div className="coverage" data-testid="coverage">
          <div className="coverage-bar" role="img" aria-label={`${current} observed now, ${remembered} remembered`}><i style={{ width: total ? `${(100 * current) / total}%` : '0%' }} /></div>
          <p><b>{total}</b> mapped: {current} observed now, {remembered} remembered</p>
        </div>
        <dl className="kvs">
          <Kv k="Objects" v={snap.entities.filter(e => e.kind !== 'island' && e.kind !== 'fold' && e.kind !== 'swarm').length} />
          <Kv k="Islands" v={count('island')} />
          <Kv k="Folds" v={count('fold')} />
        </dl>
        <p className="muted">{snap.connected ? 'Pick a target from the list, or click a label on the map. Scan to discover more.' : 'Connect to the Dimension to begin.'}</p>
        {snap.lastScanSummary && <p className="muted small">{snap.lastScanSummary}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={!snap.connected || snap.scanPending} onClick={() => session.requestScan()}>{snap.scanPending ? 'Scanning…' : 'Scan for objects'}</button>
        </div>
      </section>
    );
  }

  const moving = target.targetClass === 'moving-object';
  const badge = planBadge(target.mode);
  const entity = snap.entities.find(e => e.id === target.id)!;
  return (
    <section className="card" data-testid="panel-tactical">
      <Eyebrow>Selected</Eyebrow>
      <h2>{target.label}</h2>
      <p className="pills"><span className={`pill ${target.knowledge}`}>{target.knowledge === 'current' ? 'OBSERVED NOW' : `LAST KNOWN ${f0(target.age)} s AGO`}</span><span className="pill plain">{badge.text}</span></p>
      <dl className="kvs">
        <Kv k="Position" v={vec(entity.position)} />
        <Kv k="From Baymax" v={bay ? `${f0(dist(entity.position, bay))} m` : '—'} />
        <Kv k="Motion" v={moving ? `${f1(target.speed ?? 0)} m/s` : target.motion === 'static' ? 'not moving' : target.motion} />
      </dl>
      {target.constraints.map(c => <p key={c} className="note warn">{c}</p>)}
      <p className="muted small">{target.note}</p>
      <div className="actions">
        {moving
          ? <button type="button" className="primary" onClick={() => setView('predict')} data-testid="inspect-prediction">Inspect prediction</button>
          : <button type="button" className="primary" onClick={() => setView('route')} data-testid="plan-route">Plan route</button>}
        {moving && <button type="button" className="link" onClick={() => setView('route')} data-testid="plan-route">or plan an interception</button>}
        <button type="button" className="ghost" onClick={() => scene()?.focus(target.id)}>Center</button>
      </div>
    </section>
  );
}
