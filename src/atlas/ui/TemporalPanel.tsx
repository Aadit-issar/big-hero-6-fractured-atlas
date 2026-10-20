import { useState } from 'react';
import type { AtlasView } from '../core/runtime';
import type { NumericAnalysis } from '../analysis/types';
import { distance3 } from '../analysis/models';
import './temporal-panel.css';

const number = (n: number | null | undefined, places = 3) => n === null || n === undefined ? '—' : n.toFixed(places);
const vector = (values: readonly number[]) => values.length === 1 ? number(values[0]) : `[${values.map((v) => number(v, 2)).join(', ')}]`;

function ModelCard({ analysis, testId }: { readonly analysis: NumericAnalysis; readonly testId?: string }) {
  const a = analysis;
  return <article className={`temporal-model quality-${a.quality}`} data-testid={testId}>
    <div className="temporal-model-title"><h3>{a.label}</h3><span className="analysis-quality">{a.quality}</span></div>
    <div className="model-estimate"><span>{a.forecast ? `ESTIMATE AT t=${number(a.forecast.targetTime, 2)} s` : 'ESTIMATE WITHHELD'}</span><strong>{a.forecast ? vector(a.forecast.estimate) : 'Insufficient support'}</strong><small>{a.units}</small></div>
    {a.reasons.map((reason) => <p className="model-reason" key={reason}>{reason}</p>)}
    <dl className="model-facts">
      <div><dt>Latest accepted measurement</dt><dd>{vector(a.observed)}</dd></div>
      <div><dt>Sample support</dt><dd>{a.sampleCount} · {number(a.supportStart, 2)}–{number(a.supportEnd, 2)} s</dd></div>
      <div><dt>Fitted change / s</dt><dd>{a.fits.length ? vector(a.fits.map((f) => f.slope)) : 'Unknown'}</dd></div>
      <div><dt>Error allowance</dt><dd>{a.forecast ? `± ${number(a.forecast.errorAllowance)}` : 'Unavailable'}</dd></div>
    </dl>
    <div className="model-validation"><span>Later checks <b>{a.score.evaluated}</b> (published {a.score.publishedEvaluated})</span><span>MAE · all candidates <b>{number(a.score.meanAbsoluteError)}</b></span><span>MAE · published <b>{number(a.score.publishedMeanAbsoluteError)}</b></span><span>Persistence MAE <b>{number(a.score.persistenceMeanAbsoluteError)}</b></span><span>Allowance hits <b>{a.score.envelopeHits} / {a.score.evaluated}</b></span><span>Unscorable targets <b>{a.score.skipped}</b></span></div>
  </article>;
}

function EvidenceChart({ view, signal, windowSeconds }: { readonly view: AtlasView; readonly signal: 'hazard' | 'gravity'; readonly windowSeconds: number }) {
  const analysis = view.temporal[signal];
  const latest = view.mapping.environment.at(-1)?.time ?? 0;
  const samples = view.mapping.environment.filter((s) => windowSeconds === Infinity || s.time >= latest - windowSeconds).slice(-64);
  if (!analysis || samples.length === 0) return <div className="temporal-chart-empty">Awaiting temporal evidence</div>;
  const measure = (s: (typeof samples)[number]) => signal === 'hazard' ? s.hazard : s.gravityMagnitude;
  const forecast = analysis.forecast;
  const begin = samples[0]!.time;
  const end = Math.max(begin + 1, forecast?.targetTime ?? samples.at(-1)!.time);
  const values = samples.map(measure);
  if (forecast) values.push(forecast.estimate[0]! - forecast.errorAllowance, forecast.estimate[0]! + forecast.errorAllowance);
  const low = signal === 'hazard' ? Math.min(0, ...values) : Math.min(...values) - 0.02;
  const high = signal === 'hazard' ? Math.max(1, ...values) : Math.max(...values) + 0.02;
  const x = (time: number) => 52 + (time - begin) / (end - begin) * 570;
  const y = (value: number) => 190 - (value - low) / Math.max(1e-9, high - low) * 160;
  const lastFit = analysis.fits[0];
  const last = samples.at(-1)!;
  return <svg viewBox="0 0 660 245" role="img" aria-label={`${signal} measured evidence and conditional extrapolation`} data-testid="temporal-chart">
    {[0, 0.5, 1].map((fraction) => <g key={fraction}><line className="temporal-grid" x1="52" x2="622" y1={30 + fraction * 160} y2={30 + fraction * 160} /><text x="45" y={34 + fraction * 160} textAnchor="end">{number(high - fraction * (high - low), 2)}</text></g>)}
    {samples.map((s, i) => {
      const before = samples[i - 1];
      const continuous = before && !s.breakBefore && s.time - before.time <= view.temporal.policy.maxGapSeconds && distance3(before.observerWorldPosition, s.observerWorldPosition) <= view.temporal.policy.stationaryRadius;
      return <g key={s.time}>{continuous && <line className="temporal-measurement-line" x1={x(before.time)} y1={y(measure(before))} x2={x(s.time)} y2={y(measure(s))} />}<circle className="temporal-measurement" cx={x(s.time)} cy={y(measure(s))} r="2.8"><title>Measured at t={number(s.time)} s: {number(measure(s))}</title></circle></g>;
    })}
    {forecast && lastFit && <g data-testid="forecast-geometry"><polygon className="temporal-error-envelope" points={`${x(last.time)},${y(lastFit.atLastTime)} ${x(forecast.targetTime)},${y(forecast.estimate[0]! - forecast.errorAllowance)} ${x(forecast.targetTime)},${y(forecast.estimate[0]! + forecast.errorAllowance)}`} /><line className="temporal-forecast-line" x1={x(last.time)} y1={y(lastFit.atLastTime)} x2={x(forecast.targetTime)} y2={y(forecast.estimate[0]!)} /><path d={`M ${x(forecast.targetTime) - 4} ${y(forecast.estimate[0]!)} h 8 M ${x(forecast.targetTime)} ${y(forecast.estimate[0]!) - 4} v 8`} className="temporal-forecast-marker" /></g>}
    <line className="temporal-now" x1={x(last.time)} x2={x(last.time)} y1="20" y2="198" />
    <text data-testid="temporal-chart-start" x="52" y="216">t={number(begin, 2)} s</text><text x="622" y="216" textAnchor="end">t={number(end, 2)} s</text><text x="52" y="238">SIMULATION TIME · {signal === 'hazard' ? 'SENSOR INSTABILITY SCALE' : 'WORLD UNITS / s²'}</text>
  </svg>;
}

function FoldMotionChart({ track, analysis, endpoint, axis, maxGap, discontinuity }: {
  readonly track: AtlasView['mapping']['folds'][number]['track'];
  readonly analysis: NumericAnalysis;
  readonly endpoint: 'entry' | 'exit';
  readonly axis: 0 | 1 | 2;
  readonly maxGap: number;
  readonly discontinuity: number;
}) {
  if (track.length === 0) return <div className="temporal-chart-empty">No retained endpoint measurements.</div>;
  const endpointLabel = endpoint === 'entry' ? 'entry' : 'reported exit';
  const position = (sample: (typeof track)[number]) => endpoint === 'entry' ? sample.entryPosition : sample.exitPosition;
  const last = track.at(-1)!;
  const fit = analysis.fits[axis];
  const forecast = analysis.forecast;
  const begin = track[0]!.time;
  const end = Math.max(begin + 1, forecast?.targetTime ?? last.time);
  const values = track.map((sample) => position(sample)[axis]);
  if (forecast) values.push(forecast.estimate[axis]!);
  const rawLow = Math.min(...values);
  const rawHigh = Math.max(...values);
  const padding = Math.max((rawHigh - rawLow) * 0.12, 0.05);
  const low = rawLow - padding;
  const high = rawHigh + padding;
  const x = (time: number) => 52 + (time - begin) / (end - begin) * 570;
  const y = (value: number) => 185 - (value - low) / Math.max(1e-9, high - low) * 145;
  return <svg viewBox="0 0 660 235" role="img" aria-label={`${endpointLabel} ${'XYZ'[axis]} coordinate measured history${forecast ? ' and conditional estimate' : ''}`} data-testid="fold-motion-chart" data-observed-points={track.length}>
    {[0, 0.5, 1].map((fraction) => <g key={fraction}><line className="temporal-grid" x1="52" x2="622" y1={25 + fraction * 145} y2={25 + fraction * 145} /><text x="45" y={29 + fraction * 145} textAnchor="end">{number(high - fraction * (high - low), 2)}</text></g>)}
    {track.map((sample, index) => {
      const previous = track[index - 1];
      const connected = previous && sample.time - previous.time <= maxGap
        && distance3(position(previous), position(sample)) <= discontinuity;
      return <g key={sample.time}>{connected && <line className="temporal-measurement-line" x1={x(previous.time)} y1={y(position(previous)[axis])} x2={x(sample.time)} y2={y(position(sample)[axis])} />}<circle className="temporal-measurement" cx={x(sample.time)} cy={y(position(sample)[axis])} r="3"><title>Observed {endpointLabel} coordinate at t={number(sample.time)} s: {number(position(sample)[axis])} world units</title></circle></g>;
    })}
    {forecast && fit && <g data-testid="fold-motion-estimate"><line className="temporal-forecast-line" x1={x(last.time)} y1={y(fit.atLastTime)} x2={x(forecast.targetTime)} y2={y(forecast.estimate[axis]!)} /><circle className="temporal-forecast-marker" cx={x(forecast.targetTime)} cy={y(forecast.estimate[axis]!)} r="4"><title>Conditional estimate at t={number(forecast.targetTime)} s: {number(forecast.estimate[axis])} world units</title></circle></g>}
    <line className="temporal-now" x1={x(last.time)} x2={x(last.time)} y1="18" y2="191" />
    <text x="52" y="211">t={number(begin, 2)} s</text><text x="622" y="211" textAnchor="end">t={number(end, 2)} s</text><text x="52" y="230">WORLD {"XYZ"[axis]} · {track.length} OBSERVED SAMPLES</text>
  </svg>;
}

export function TemporalPanel({ view, selected, onSelect }: { readonly view: AtlasView; readonly selected: string; readonly onSelect: (key: string) => void }) {
  const [signal, setSignal] = useState<'hazard' | 'gravity'>('hazard');
  const [endpoint, setEndpoint] = useState<'entry' | 'exit'>('entry');
  const [coordinateAxis, setCoordinateAxis] = useState<0 | 1 | 2>(0);
  const [windowSeconds, setWindowSeconds] = useState(8);
  const [showAudit, setShowAudit] = useState(false);
  const temporal = view.temporal;
  const fold = temporal.folds.find((f) => selected === `fold:${f.id}`) ?? temporal.folds.find((f) => f.currentlyObserved) ?? temporal.folds[0];
  const island = temporal.islands.find((i) => selected === `island:${i.id}`);
  const foldTrack = view.mapping.folds.find((f) => f.id === fold?.id)?.track.slice(-(fold?.sampleCount ?? 0)) ?? [];
  return <section className="panel temporal-panel" aria-labelledby="temporal-title" data-testid="temporal-panel">
    <div className="panel-heading"><div><p className="eyebrow">TEMPORAL INTELLIGENCE / PHASE 03</p><h2 id="temporal-title">Change, evidence & uncertainty</h2></div><span className="count-tag">{temporal.evaluatedForecasts} RETAINED CHECKS</span></div>
    <div className="temporal-disclosure"><strong>{temporal.available ? 'Observation-driven analysis' : temporal.statusReason}</strong><p>Local linear estimates assume recent measured behaviour continues for {temporal.policy.horizonSeconds} model second. Error allowances describe fit residuals and past forecast errors; they are not calibrated probability intervals or safety guarantees.</p></div>
    {temporal.concerns.length > 0 && <div className="temporal-concerns" data-testid="temporal-concerns">{temporal.concerns.map((c) => <article className={`concern concern-${c.severity}`} key={c.id}><div><strong>{c.title}</strong><small>{c.source.replaceAll('-', ' ')} · t={number(c.time, 2)} s</small></div><p>{c.explanation}</p></article>)}</div>}
    {!temporal.hazard ? <div className="temporal-chart-empty">No analytical evidence yet. Valid, distinct simulation timestamps are required.</div> : <>
      <div className="temporal-environment-grid"><div className="temporal-chart-panel"><div className="temporal-chart-toolbar"><h3>Local environmental evidence</h3><div className="temporal-toggle"><button aria-pressed={signal === 'hazard'} onClick={() => setSignal('hazard')}>Instability evidence</button><button aria-pressed={signal === 'gravity'} onClick={() => setSignal('gravity')}>Gravity evidence</button><label>Window <select aria-label="Environmental chart time window" value={windowSeconds === Infinity ? 'all' : String(windowSeconds)} onChange={(e) => setWindowSeconds(e.target.value === 'all' ? Infinity : Number(e.target.value))}><option value="4">4 model seconds</option><option value="8">8 model seconds</option><option value="16">16 model seconds</option><option value="all">Latest retained samples</option></select></label></div></div><EvidenceChart view={view} signal={signal} windowSeconds={windowSeconds} /><div className="temporal-legend"><span>● Observed samples</span><span>┄ Conditional estimate</span><span>△ Descriptive error allowance</span></div><p className="temporal-note">Environmental fits use a stationary-locality window (radius {temporal.policy.stationaryRadius} world units). They do not describe conditions at fold destinations.</p></div><ModelCard analysis={temporal[signal]!} testId="environment-model" /></div>
      <div className="temporal-fold-heading"><div><p className="eyebrow">OBSERVED FOLD DYNAMICS</p><h3>Endpoint motion & visible-state history</h3></div><label>Inspect fold <select aria-label="Temporal fold selection" value={fold?.id ?? ''} onChange={(e) => onSelect(`fold:${e.target.value}`)}>{temporal.folds.length === 0 && <option value="">No observed folds</option>}{temporal.folds.map((f) => <option key={f.id} value={f.id}>{f.id} · {f.currentlyObserved ? 'current' : 'historical'}</option>)}</select></label></div>
      {fold ? <div className="fold-analysis" data-testid="fold-analysis"><div className="fold-analysis-summary"><div><span>VISIBLE LABEL</span><strong>{fold.currentState ?? `Unknown now · last ${fold.lastObservedState}`}</strong></div><div><span>SAMPLED CHANGES</span><strong>{fold.observedTransitions}</strong></div><div><span>SAME-LABEL SAMPLE SPAN</span><strong>{number(fold.sampledStateSupportSeconds, 2)} s</strong></div><div><span>FIRST SEEN</span><strong>t={number(fold.firstSeenAt, 2)} s</strong></div><div><span>LAST OBSERVED</span><strong>t={number(fold.lastSeenAt, 2)} s</strong></div></div>
        <div className="fold-state-evidence" aria-label="Fold visible state samples">{foldTrack.map((s) => <span className={`state-sample state-${s.state}`} key={s.time} title={`t=${number(s.time)} s · ${s.state}`}>{s.state.slice(0, 1).toUpperCase()}</span>)}</div>
        {fold.recentTransitions.length > 0 && <ol className="fold-transition-list" aria-label="Observed fold state transitions">{fold.recentTransitions.map((event) => <li key={`${event.earliestAfter}:${event.from}:${event.to}`}><b>{event.from} → {event.to}</b><span>occurred after t={number(event.earliestAfter, 2)} s and by t={number(event.latestAt, 2)} s</span></li>)}</ol>}
        <div className="label-estimate"><strong>Fold-state forecasting disabled</strong><p>{fold.nextLabelReason}</p><p>Descriptive adjacent-sample transition counts: {fold.nextLabelCounts.length ? fold.nextLabelCounts.map((c) => `${c.state} ${c.count}`).join(' · ') : 'No transitions from the latest observed label in retained evidence'}. Counts are not independent predictive validation.</p></div>
        <div className="fold-motion-chart-panel"><div className="temporal-chart-toolbar"><h3>Observed endpoint coordinate</h3><div className="temporal-toggle"><label>Endpoint <select aria-label="Fold endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value as 'entry' | 'exit')}><option value="entry">Entry</option><option value="exit">Reported exit</option></select></label><label>World axis <select aria-label="World coordinate axis" value={coordinateAxis} onChange={(e) => setCoordinateAxis(Number(e.target.value) as 0 | 1 | 2)}><option value={0}>X</option><option value={1}>Y</option><option value={2}>Z</option></select></label></div></div><FoldMotionChart track={foldTrack} analysis={endpoint === 'entry' ? fold.entry : fold.exit} endpoint={endpoint} axis={coordinateAxis} maxGap={temporal.policy.maxGapSeconds} discontinuity={temporal.policy.discontinuityDistance} /><div className="temporal-legend"><span>● Sensor-reported coordinate</span><span>┄ Conditional estimate from latest fit</span></div><p className="temporal-note">Gaps are left blank. This is a world-coordinate history; the estimate is not an observed endpoint or a traversal path.</p></div>
        <div className="temporal-motion-grid"><ModelCard analysis={fold.entry} /><ModelCard analysis={fold.exit} /><ModelCard analysis={fold.endpointSeparation} /></div>
        <p className="temporal-note">Fold labels may incorporate approximately one second of shared-sensor lookahead. ATLAS records transitions descriptively and does not forecast fold labels or claim independent status-prediction accuracy. Sampled state spans do not establish uninterrupted availability, exact closure time, or safe passage.</p>
      </div> : <p className="temporal-note">No fold has been observed. No fold dynamics are fabricated.</p>}
      {temporal.islands.length > 0 && <details className="island-motion"><summary>Island motion · {temporal.islands.length} evidence records</summary><label>Inspect island <select aria-label="Temporal island selection" value={island?.id ?? ''} onChange={(e) => onSelect(`island:${e.target.value}`)}><option value="">Select an observed identity</option>{temporal.islands.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}</select></label>{island && <ModelCard analysis={island.motion} />}</details>}
    </>}
    <div className="temporal-audit"><button aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'Hide' : 'Inspect'} forecast audit</button><p>Each check compares an earlier issued estimate with a later observation. Shadow candidates are not published as forecasts, but are scored to test model recovery. Actual target timestamps are retained; a maximum {temporal.policy.maxScoreDelaySeconds} s scoring delay permits delivery cadence jitter. Checks finalize on the next distinct timestamp.</p>
      {showAudit && <div className="audit-scroll" data-testid="forecast-audit"><table><thead><tr><th>Signal</th><th>Published</th><th>Issued</th><th>Target</th><th>Observed</th><th>Error</th><th>Persistence error</th></tr></thead><tbody>{temporal.evaluations.slice(-16).reverse().map((e) => <tr key={`${e.key}:${e.issuedAt}`}><td>{e.key}</td><td>{e.published ? 'Yes' : 'Shadow'}</td><td>{number(e.issuedAt, 2)}</td><td>{number(e.targetTime, 2)}</td><td>{number(e.observedAt, 2)}</td><td>{number(e.error)}</td><td>{number(e.persistenceError)}</td></tr>)}</tbody></table>{temporal.evaluations.length === 0 && <p>No later-observation checks yet.</p>}</div>}
    </div>
  </section>;
}
