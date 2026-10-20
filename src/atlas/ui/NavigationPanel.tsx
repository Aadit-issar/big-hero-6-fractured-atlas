import { useState } from 'react';
import type { WorldVec3 } from '../../shared/atlasContract';
import type { NavChange } from '../navigation/advisor';
import type { NavigationAdvice } from '../navigation/types';

const STATUS: Record<NavigationAdvice['status'], { label: string; tone: 'ok' | 'warn' | 'info' | 'dim' }> = {
  route: { label: 'CANDIDATE ROUTE', tone: 'ok' },
  'needs-revalidation': { label: 'NEEDS REVALIDATION', tone: 'warn' },
  'no-route': { label: 'NO SUPPORTED ROUTE', tone: 'warn' },
  explore: { label: 'OBSERVATION PRIORITY', tone: 'info' },
  abstain: { label: 'INSUFFICIENT EVIDENCE', tone: 'dim' },
};
const SUPPORT: Record<string, string> = { 'observed-fold': 'fold open now', 'remembered-fold': 'fold, last-known', 'recorded-track': 'along recorded movement', 'unverified-approach': 'unverified approach' };
const fmt = (p: readonly number[]) => p.map(n => n.toFixed(1)).join(', ');

export interface NavigationPanelProps {
  readonly advice: NavigationAdvice;
  readonly goalId: string | null;
  readonly onGoal: (id: string | null) => void;
  readonly onFocus: (position: WorldVec3 | null) => void;
  readonly changes: readonly NavChange[];
  readonly onClose: () => void;
}

/** The navigation advisor: pick a known destination, read what ATLAS can and cannot support, and inspect why. */
export function NavigationPanel({ advice, goalId, onGoal, onFocus, changes, onClose }: NavigationPanelProps) {
  const [why, setWhy] = useState(false);
  const status = STATUS[advice.status];
  const kinds: [string, string][] = [['island', 'Islands'], ['fold-entry', 'Fold entries'], ['fold-exit', 'Reported fold exits'], ['landmark', 'Scanned landmarks']];
  const rec = advice.recommendation;
  const lastChange = changes.at(-1);
  return (
    <aside className="aug-nav" aria-label="Navigation advisor" data-testid="navigation-panel" data-status={advice.status}>
      <button className="aug-close" aria-label="Close navigation advisor" onClick={onClose}>×</button>
      <p className="aug-kicker">NAVIGATION ADVISOR</p>
      <label className="aug-nav-goal">Destination
        <select aria-label="Navigation destination" value={goalId ?? ''} onChange={e => onGoal(e.target.value || null)}>
          <option value="">None: where should Baymax look next?</option>
          {kinds.map(([kind, title]) => { const items = advice.goals.filter(g => g.kind === kind); return items.length ? <optgroup key={kind} label={title}>{items.map(g => <option key={g.id} value={g.id}>{g.label}{g.status === 'remembered' ? ' (last-known)' : ''}</option>)}</optgroup> : null; })}
        </select>
      </label>
      <p className={`aug-nav-status tone-${status.tone}`} data-testid="navigation-status">{status.label}</p>
      <h3 className="aug-nav-title">{rec.title}</h3>
      <p className="aug-nav-detail">{rec.detail}</p>
      {advice.reason && advice.status !== 'explore' && <p className="aug-nav-reason">{advice.reason}.</p>}
      {lastChange && <p className="aug-nav-change" data-testid="navigation-change">{lastChange.message}</p>}
      <div className="aug-nav-actions">
        <button onClick={() => onGoal(null)} disabled={!goalId && advice.status === 'explore'}>Recommend next observation</button>
        <button onClick={() => onFocus(rec.target)} disabled={!rec.target}>Show target</button>
        <button onClick={() => setWhy(v => !v)} aria-expanded={why}>{why ? 'Hide evidence' : 'Why?'}</button>
      </div>
      {why && (
        <div className="aug-nav-why" data-testid="navigation-evidence">
          {advice.route && <>
            <h4>Route</h4>
            <ol>{advice.route.segments.map(s => <li key={s.edgeId} className={s.caution ? 'caution' : ''}><b>{s.kind === 'fold-transition' ? 'Fold' : 'Fly'}</b> {s.length.toFixed(0)} units · {SUPPORT[s.support]}{s.notes.length ? <em>{s.notes.join('; ')}</em> : null}</li>)}</ol>
          </>}
          {advice.alternatives.length > 0 && <>
            <h4>Alternatives</h4>
            <ul>{advice.alternatives.map(a => <li key={a.nodes.join('>')}>{a.segments.length} segment{a.segments.length === 1 ? '' : 's'}, {a.totalLength.toFixed(0)} units{a.foldDependencies.length ? `, uses ${a.foldDependencies.map(f => f.foldId).join(', ')}` : ', no fold'}</li>)}</ul>
          </>}
          <h4>Evidence</h4>
          <ul>{advice.evidence.map((e, i) => <li key={i} className={`ev-${e.kind}`}><i>{e.kind}</i> {e.text}</li>)}</ul>
          {advice.frontiers.length > 0 && <>
            <h4>Observation priorities</h4>
            <ol>{advice.frontiers.slice(0, 3).map(f => <li key={f.id}><b>{f.label}</b> · score {f.score.toFixed(0)} · {f.distance.toFixed(0)} units away<em>{f.reasons.join('. ')}</em></li>)}</ol>
          </>}
          <h4>Limitations</h4>
          <ul>{advice.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <p className="aug-note">Ranking uses documented weights, not probabilities. Target {rec.target ? fmt(rec.target) : '—'} · computed at sim t {advice.simTime === null ? '—' : advice.simTime.toFixed(2)}s.</p>
        </div>
      )}
    </aside>
  );
}
