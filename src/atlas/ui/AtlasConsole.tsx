import { useState } from 'react';
import type { ObservedConnectionState } from '../../shared/atlasContract';
import type { ConnectionDiagnostic, IslandDiagnostic } from '../core/diagnostics';
import type { AtlasView, SensorStatus } from '../core/runtime';
import { ExplorationMap } from './ExplorationMap';
import { TemporalPanel } from './TemporalPanel';
import './atlas-console.css';
import './exploration-map.css';

export interface AtlasConsoleProps {
  readonly view: AtlasView;
  readonly sourceLabel: string;
}

type Selection = { readonly kind: 'island'; readonly id: string } | { readonly kind: 'fold'; readonly id: string };
type TimelineSignal = 'hazard' | 'gravity' | 'islands' | 'folds';

const statusLabels: Record<SensorStatus, string> = {
  awaiting: 'Awaiting observation',
  receiving: 'Receiving observations',
  unchanged: 'Simulation time unchanged',
  stale: 'Delivery stale',
  invalid: 'Invalid observation',
  unavailable: 'Sensor unavailable',
};

function format(value: number, digits = 2): string {
  return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value).toFixed(digits) : '—';
}

function formatPosition(position: readonly [number, number, number]): string {
  return `X ${format(position[0])}  ·  Y ${format(position[1])}  ·  Z ${format(position[2])}`;
}

function stateClass(state: ObservedConnectionState): string {
  return `state-${state}`;
}

function itemKey(selection: Selection): string {
  return `${selection.kind}:${selection.id}`;
}

function isSelected(selected: string, kind: Selection['kind'], id: string): boolean {
  return selected === itemKey({ kind, id });
}

function StateBadge({ status }: { readonly status: SensorStatus }) {
  return <span className={`health-badge health-${status}`}><span className="health-dot" />{statusLabels[status]}</span>;
}

function Radar({ view, selected, onSelect }: {
  readonly view: AtlasView;
  readonly selected: string;
  readonly onSelect: (selection: Selection) => void;
}) {
  const observation = view.observation;
  const diagnostics = view.diagnostics;
  const size = 520;
  const center = size / 2;
  const radius = 214;
  const range = observation?.sensorRange ?? 60;
  const project = (point: readonly [number, number, number]) => ({
    x: center + ((point[0] - (observation?.observerWorldPosition[0] ?? 0)) / range) * radius,
    y: center - ((point[2] - (observation?.observerWorldPosition[2] ?? 0)) / range) * radius,
  });

  return (
    <div className="radar-wrap">
      <svg className="local-radar" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="World-aligned local observation radar using world X and Z coordinates">
        <defs>
          <radialGradient id="radar-fill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#112b3b" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#07121d" stopOpacity="0.22" />
          </radialGradient>
          <clipPath id="radar-clip"><circle cx={center} cy={center} r={radius} /></clipPath>
        </defs>
        <circle cx={center} cy={center} r={radius} fill="url(#radar-fill)" className="radar-boundary" />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <g key={fraction}>
            <circle cx={center} cy={center} r={radius * fraction} className="radar-ring" />
            <text x={center + 5} y={center - radius * fraction + 15} className="radar-range-label">{format(range * fraction, 0)}</text>
          </g>
        ))}
        <line x1={center - radius} y1={center} x2={center + radius} y2={center} className="radar-axis" />
        <line x1={center} y1={center - radius} x2={center} y2={center + radius} className="radar-axis" />
        <text x={center + radius - 3} y={center - 9} textAnchor="end" className="radar-axis-label">+X</text>
        <text x={center + 8} y={center - radius + 14} className="radar-axis-label">+Z</text>
        <text x={center + radius - 5} y={center + radius - 9} textAnchor="end" className="radar-axis-label">−X</text>
        <text x={center + 8} y={center + radius - 7} className="radar-axis-label">−Z</text>
        <g clipPath="url(#radar-clip)">
          {diagnostics?.connections.map(({ observed, entryDistance, exitDistance }: ConnectionDiagnostic) => {
            const entry = project(observed.entryWorldPosition);
            const exit = project(observed.exitWorldPosition);
            const entryInRange = entryDistance <= range;
            const exitInRange = exitDistance <= range;
            const selectedFold = isSelected(selected, 'fold', observed.id);
            return (
              <g key={observed.id} className={`radar-fold ${selectedFold ? 'radar-selected' : ''}`}>
                {entryInRange && exitInRange && <line x1={entry.x} y1={entry.y} x2={exit.x} y2={exit.y} className="radar-fold-link" />}
                {entryInRange && (
                  <g role="button" tabIndex={0} aria-label={`Select fold ${observed.id} entry`} onClick={() => onSelect({ kind: 'fold', id: observed.id })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'fold', id: observed.id }); } }}>
                    <title>{`${observed.id} entry · ${format(entryDistance)} world units · ${observed.state}`}</title>
                    <path d={`M ${entry.x} ${entry.y - 8} L ${entry.x + 8} ${entry.y} L ${entry.x} ${entry.y + 8} L ${entry.x - 8} ${entry.y} Z`} className={`radar-fold-marker ${stateClass(observed.state)}`} />
                    {selectedFold && <text x={entry.x + 10} y={entry.y - 10} className="radar-marker-label">{observed.id}</text>}
                  </g>
                )}
                {exitInRange && (
                  <g role="button" tabIndex={0} aria-label={`Select fold ${observed.id} exit`} onClick={() => onSelect({ kind: 'fold', id: observed.id })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'fold', id: observed.id }); } }}>
                    <title>{`${observed.id} exit · ${format(exitDistance)} world units`}</title>
                    <circle cx={exit.x} cy={exit.y} r={entryInRange ? 3.5 : 6} className="radar-fold-exit" />
                  </g>
                )}
              </g>
            );
          })}
          {diagnostics?.islands.map(({ observed, distance }: IslandDiagnostic) => {
            if (distance > range) return null;
            const point = project(observed.worldPosition);
            const selectedIsland = isSelected(selected, 'island', observed.id);
            return (
              <g key={observed.id} role="button" tabIndex={0} aria-label={`Select island ${observed.id}`} className={`radar-island ${selectedIsland ? 'radar-selected' : ''}`} onClick={() => onSelect({ kind: 'island', id: observed.id })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'island', id: observed.id }); } }}>
                <title>{`${observed.id} · ${format(distance)} world units`}</title>
                <circle cx={point.x} cy={point.y} r={selectedIsland ? 9 : 6.5} className="radar-island-marker" />
                {selectedIsland && <text x={point.x + 10} y={point.y + 4} className="radar-marker-label">{observed.id}</text>}
              </g>
            );
          })}
        </g>
        <circle cx={center} cy={center} r="9" className="radar-observer" />
        <circle cx={center} cy={center} r="2.5" className="radar-observer-core" />
      </svg>
      <div className="radar-caption"><span>WORLD ALIGNED</span><span>HORIZONTAL X / VERTICAL Z</span></div>
      <div className="radar-legend" aria-label="Radar legend">
        <span><i className="legend-explorer" />Observer</span>
        <span><i className="legend-island" />Observed island</span>
        <span><i className="legend-fold" />Fold entry</span>
        <span className="legend-range">Boundary: {format(range, 0)} world units · projected sensor radius</span>
      </div>
      <p className="panel-footnote">Local observations only. This plot is not a complete map and does not encode heading, occlusion or safety.</p>
    </div>
  );
}

function NearbyObjects({ view, selected, onSelect }: {
  readonly view: AtlasView;
  readonly selected: string;
  readonly onSelect: (selection: Selection) => void;
}) {
  const diagnostics = view.diagnostics;
  return (
    <section className="panel object-panel" aria-labelledby="objects-title" data-testid="nearby-objects">
      <div className="panel-heading">
        <div><p className="eyebrow">CURRENT SENSOR SET</p><h2 id="objects-title">Nearby objects</h2></div>
        <span className="count-tag">{diagnostics ? diagnostics.islands.length + diagnostics.connections.length : 0} observed</span>
      </div>
      {!diagnostics || (diagnostics.islands.length === 0 && diagnostics.connections.length === 0) ? (
        <div className="empty-inline">{view.observation ? 'No islands or folds are in the current observed set.' : 'Object data is unavailable until a valid observation arrives.'}</div>
      ) : (
        <div className="object-list">
          {diagnostics.islands.map(({ observed, distance }: IslandDiagnostic) => (
            <button key={`island:${observed.id}`} type="button" className={`object-row ${isSelected(selected, 'island', observed.id) ? 'object-selected' : ''}`} onClick={() => onSelect({ kind: 'island', id: observed.id })}>
              <span className="object-symbol island-symbol">I</span>
              <span className="object-main"><span className="object-name">{observed.id}</span><span className="object-detail">Island · {formatPosition(observed.worldPosition)}</span></span>
              <span className="object-distance">{format(distance)}<small>WORLD UNITS</small></span>
            </button>
          ))}
          {diagnostics.connections.map(({ observed, entryDistance, exitDistance }: ConnectionDiagnostic) => (
            <button key={`fold:${observed.id}`} type="button" className={`object-row ${isSelected(selected, 'fold', observed.id) ? 'object-selected' : ''}`} onClick={() => onSelect({ kind: 'fold', id: observed.id })}>
              <span className="object-symbol fold-symbol">F</span>
              <span className="object-main"><span className="object-name">{observed.id}<span className={`state-pill ${stateClass(observed.state)}`}>{observed.state}</span></span><span className="object-detail">Fold · entry {format(entryDistance)} / exit {format(exitDistance)} units</span></span>
              <span className="object-distance">{format(observed.range)}<small>NEARER ENDPOINT</small></span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SelectedDetails({ view, selected }: { readonly view: AtlasView; readonly selected: string }) {
  const [kind, ...idParts] = selected.split(':');
  const id = idParts.join(':');
  const island = kind === 'island' ? view.diagnostics?.islands.find((entry) => entry.observed.id === id) : undefined;
  const fold = kind === 'fold' ? view.diagnostics?.connections.find((entry) => entry.observed.id === id) : undefined;
  return (
    <section className="panel selected-panel" aria-labelledby="selected-title" data-testid="selected-object-panel">
      <div className="panel-heading"><div><p className="eyebrow">DETAIL INSPECTOR</p><h2 id="selected-title">Selected observation</h2></div></div>
      {!island && !fold ? <div className="empty-inline">Select a visible radar marker or nearby object to inspect its observed values.</div> : island ? (
        <div className="detail-stack">
          <div className="detail-title-line"><span className="object-symbol island-symbol">I</span><strong>{island.observed.id}</strong><span className="type-label">OBSERVED ISLAND</span></div>
          <Detail label="World position" value={formatPosition(island.observed.worldPosition)} />
          <Detail label="Relative displacement" value={formatPosition(island.displacement)} />
          <Detail label="Calculated distance" value={`${format(island.distance)} world units`} />
          <Detail label="Sensor reported range" value={`${format(island.observed.range)} world units`} />
        </div>
      ) : fold ? (
        <div className="detail-stack" data-testid="selected-fold-detail">
          <div className="detail-title-line"><span className="object-symbol fold-symbol">F</span><strong>{fold.observed.id}</strong><span className={`state-pill ${stateClass(fold.observed.state)}`}>{fold.observed.state}</span></div>
          <Detail label="Entry position" value={formatPosition(fold.observed.entryWorldPosition)} />
          <Detail label="Exit position" value={formatPosition(fold.observed.exitWorldPosition)} />
          <Detail label="Distance to entry" value={`${format(fold.entryDistance)} world units`} />
          <Detail label="Distance to exit" value={`${format(fold.exitDistance)} world units`} />
          <p className="caveat-note">Visible fold status is a current contract label. It is not a closure forecast or a safety guarantee.</p>
        </div>
      ) : null}
    </section>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

function Timeline({ view }: { readonly view: AtlasView }) {
  const [signal, setSignal] = useState<TimelineSignal>('hazard');
  const measurements: readonly { readonly id: TimelineSignal; readonly label: string; readonly unit: string }[] = [
    { id: 'hazard', label: 'Local hazard', unit: 'scale 0–1' },
    { id: 'gravity', label: 'Gravity magnitude', unit: 'world units / s²' },
    { id: 'islands', label: 'Visible islands', unit: 'count' },
    { id: 'folds', label: 'Visible folds', unit: 'count' },
  ];
  const observations = view.mapping.environment.slice(-48);
  const valueOf = (observation: typeof observations[number]): number => {
    if (signal === 'hazard') return observation.hazard;
    if (signal === 'gravity') return observation.gravityMagnitude;
    if (signal === 'islands') return observation.visibleIslandCount;
    return observation.visibleFoldCount;
  };
  const values = observations.map(valueOf);
  const max = signal === 'hazard' ? 1 : Math.max(1, ...values);
  const min = signal === 'gravity' ? Math.min(0, ...values) : 0;
  const span = Math.max(1e-9, max - min);
  const chartWidth = 640;
  const chartHeight = 150;
  const padX = 22;
  const padY = 16;
  const firstTime = observations[0]?.time ?? 0;
  const lastTime = observations.at(-1)?.time ?? firstTime;
  const timeSpan = Math.max(1e-9, lastTime - firstTime);
  const points = values.map((value, index) => ({
    x: padX + ((observations[index]?.time ?? firstTime) - firstTime) / timeSpan * (chartWidth - padX * 2),
    y: chartHeight - padY - ((value - min) / span) * (chartHeight - padY * 2),
    value,
    time: observations[index]?.time ?? 0,
    breakBefore: observations[index]?.breakBefore ?? false,
  }));
  const lineSegments: typeof points[] = [];
  for (const point of points) {
    if (point.breakBefore || lineSegments.length === 0) lineSegments.push([point]);
    else lineSegments[lineSegments.length - 1]?.push(point);
  }
  const selectedMeasurement = measurements.find((measurement) => measurement.id === signal) ?? measurements[0];
  const lastValue = values.at(-1);

  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title" data-testid="observation-timeline">
      <div className="panel-heading timeline-heading">
        <div><p className="eyebrow">SESSION MEASUREMENTS · {view.mapping.summary.environmentSampleCount} RETAINED</p><h2 id="timeline-title">Observation timeline</h2></div>
        {selectedMeasurement && <div className="timeline-current"><span>{selectedMeasurement.label}</span><strong>{lastValue === undefined ? '—' : format(lastValue, signal === 'islands' || signal === 'folds' ? 0 : 2)}</strong><small>{selectedMeasurement.unit}</small></div>}
      </div>
      <div className="signal-tabs" role="group" aria-label="Timeline measurement">
        {measurements.map((measurement) => <button key={measurement.id} type="button" className={signal === measurement.id ? 'signal-active' : ''} onClick={() => setSignal(measurement.id)}>{measurement.label}</button>)}
      </div>
      {points.length === 0 ? <div className="empty-inline">No accepted samples are available to plot.</div> : (
        <div className="chart-wrap">
          <svg className="timeline-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${selectedMeasurement?.label ?? 'Observation'} measured from ${observations.length} accepted sensor samples; no forecast`}>
            {[0.25, 0.5, 0.75].map((fraction) => <line key={fraction} x1={padX} x2={chartWidth - padX} y1={padY + fraction * (chartHeight - padY * 2)} y2={padY + fraction * (chartHeight - padY * 2)} className="chart-grid" />)}
            {lineSegments.filter((segment) => segment.length > 1).map((segment, index) => <polyline key={'signal-segment-' + index} points={segment.map(({ x, y }) => `${x},${y}`).join(' ')} className="chart-line" />)}
            {points.map((point, index) => <circle key={`${point.time}-${index}`} cx={point.x} cy={point.y} r={index === points.length - 1 ? 4.2 : 2.5} className={index === points.length - 1 ? 'chart-point chart-point-current' : 'chart-point'}><title>{`t=${format(point.time, 2)} s · ${format(point.value, 3)}`}</title></circle>)}
          </svg>
          <div className="chart-axis"><span>{observations[0] ? `t ${format(observations[0].time)} s` : '—'}</span><span>simulation time →</span><span>{observations.at(-1) ? `t ${format(observations.at(-1)?.time ?? 0)} s` : '—'}</span></div>
        </div>
      )}
      <p className="panel-footnote">Recorded observations only. The plotted signal does not extrapolate future behavior.</p>
    </section>
  );
}

function EventFeed({ view }: { readonly view: AtlasView }) {
  return (
    <section className="panel event-panel" aria-labelledby="events-title" data-testid="event-feed">
      <div className="panel-heading"><div><p className="eyebrow">OBSERVATION-DRIVEN</p><h2 id="events-title">Event feed</h2></div><span className="count-tag">{view.events.length} recent</span></div>
      {view.events.length === 0 ? <div className="empty-inline">No changes have been recorded in this session.</div> : (
        <ol className="event-list">{view.events.slice(0, 12).map((event) => (
          <li key={event.id} className={`event-item event-${event.kind}`}>
            <span className="event-mark" aria-hidden="true" />
            <div><p>{event.message}</p><time>{event.simulationTime === null ? 'SENSOR TIME UNAVAILABLE' : `SIM ${format(event.simulationTime)} S`}</time></div>
          </li>
        ))}</ol>
      )}
    </section>
  );
}

export function AtlasConsole({ view, sourceLabel }: AtlasConsoleProps) {
  const [selected, setSelected] = useState('');
  const observation = view.observation;
  const diagnostics = view.diagnostics;
  const reliabilityWarning = view.status === 'stale' || view.status === 'invalid' || view.status === 'unavailable';
  const warnings = [
    view.status === 'awaiting' ? 'No sensor snapshot has been received.' : null,
    view.status === 'stale' ? 'Observation delivery is stale. Values below are held from the last accepted sample.' : null,
    view.status === 'invalid' ? `Last observation was rejected. ${view.lastError ?? 'Diagnostic values are not current.'}` : null,
    view.status === 'unavailable' ? `Sensor source is unavailable. ${view.lastError ?? 'No current measurement is available.'}` : null,
  ].filter((warning): warning is string => warning !== null);

  return (
    <main className="atlas-shell">
      <div className="atlas-grid-texture" aria-hidden="true" />
      <div className="atlas-frame">
        <header className="system-header">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
            <div><p className="brand-overline">BAYMAX · FIELD SYSTEMS</p><h1>ATLAS</h1><p className="brand-subtitle">Adaptive Topological Location and Analysis System</p></div>
          </div>
          <div className="header-status">
            <span className="source-tag">{sourceLabel}</span>
            <StateBadge status={view.status} />
            <span className="contract-tag">SENSOR CONTRACT 01</span>
          </div>
        </header>

        <section className="mission-strip" aria-label="Current mission state">
          <Metric label="SIMULATION TIME" value={observation ? `${format(observation.time)} s` : '—'} detail="model seconds" />
          <Metric label="OBSERVER POSITION" value={observation ? formatPosition(observation.observerWorldPosition) : 'Unknown'} detail="world coordinates · rendering units" />
          <Metric label="OBSERVED ISLANDS" value={String(observation?.islands.length ?? '—')} detail="current sensor set" />
          <Metric label="OBSERVED FOLDS" value={String(observation?.connections.length ?? '—')} detail="current sensor set" />
          <Metric label="BUFFERED SAMPLES" value={String(view.sampleCount)} detail={`session ${String(view.session).padStart(2, '0')}`} />
        </section>

        {warnings.length > 0 && <section className={`health-notice ${reliabilityWarning ? 'notice-warning' : 'notice-neutral'}`} role={reliabilityWarning ? 'alert' : 'status'}>
          <span className="notice-glyph">{reliabilityWarning ? '!' : 'i'}</span><div><strong>{statusLabels[view.status]}</strong><p>{warnings.join(' ')}</p></div>
        </section>}

        <section className="primary-grid">
          <section className="panel radar-panel" aria-labelledby="radar-title" data-testid="local-radar-panel">
            <div className="panel-heading"><div><p className="eyebrow">LOCAL SPATIAL OBSERVATION</p><h2 id="radar-title">Proximity radar</h2></div><span className="range-tag">RANGE {observation ? format(observation.sensorRange, 0) : '—'} WORLD UNITS</span></div>
            {observation ? <Radar view={view} selected={selected} onSelect={(item) => setSelected(itemKey(item))} /> : <div className="radar-empty"><div className="radar-empty-mark">◎</div><strong>Radar awaiting sensor lock</strong><span>World-aligned X / Z view will appear when a valid observation arrives.</span></div>}
          </section>

          <div className="side-stack">
            <section className="panel environment-panel" aria-labelledby="environment-title">
              <div className="panel-heading"><div><p className="eyebrow">OBSERVER LOCALITY</p><h2 id="environment-title">Environment</h2></div><span className="live-pin">LOCAL</span></div>
              {diagnostics && observation ? <>
                <div className="environment-reading gravity-reading"><div className="reading-label"><span>GRAVITY ANOMALY</span><span>WORLD FRAME</span></div><strong className="reading-value">{format(diagnostics.gravityMagnitude)}<small> world units / s²</small></strong><div className="vector-line">g = [{observation.local.gravity.map((component) => format(component)).join(', ')}]</div></div>
                <div className="environment-reading hazard-reading"><div className="reading-label"><span>LOCAL INSTABILITY</span><span>OBSERVER POSITION</span></div><strong className="reading-value">{format(diagnostics.hazard)}<small> / 1.00</small></strong><div className="hazard-meter" aria-label={`Sensor-reported hazard ${format(diagnostics.hazard)}`}><span style={{ width: `${diagnostics.hazard * 100}%` }} /></div><p className="reading-note">Sensor-reported scale 0–1. No risk probability inferred.</p></div>
              </> : <div className="empty-inline environment-empty">Local readings are unavailable until a valid snapshot arrives.</div>}
              {observation && <p className="panel-footnote">Both readings are captured at the observer's current world position.</p>}
            </section>
            <SelectedDetails view={view} selected={selected} />
          </div>
        </section>

        <ExplorationMap map={view.mapping} selected={selected} sensorStatus={view.status} onSelect={(item) => setSelected(itemKey(item))} />
        <TemporalPanel view={view} selected={selected} onSelect={setSelected} />

        <section className="secondary-grid">
          <NearbyObjects view={view} selected={selected} onSelect={(item) => setSelected(itemKey(item))} />
          <EventFeed view={view} />
        </section>

        <Timeline view={view} />

        <footer className="phase-footer">
          <div><p className="eyebrow">SYSTEM DEVELOPMENT</p><h2>Capability status</h2><p>ATLAS Phases 1–3 · Observation, memory and temporal analysis</p></div>
          <div className="phase-indicators">
            <span className="phase-current"><i>01</i> Observation <b>ACTIVE</b></span>
            <span className="phase-current"><i>02</i> Topological map <b>ACTIVE</b></span>
            <span className="phase-current"><i>03</i> Temporal analysis <b>ACTIVE</b></span>
            <span><i>04</i> Route planning <b>NOT IMPLEMENTED</b></span>
            <span><i>05</i> Origin recovery <b>NOT IMPLEMENTED</b></span>
          </div>
          <p className="honesty-note">Short-horizon estimates require observational support. Route planning and origin recovery await later phases.</p>
        </footer>

        <div className="system-baseline"><span>ATLAS / OBSERVATION CONSOLE</span><span>READ-ONLY SENSOR DISPLAY</span><span>{observation ? `LAST SAMPLE · SIM ${format(observation.time)} S` : 'NO VALID SAMPLE'}</span></div>
      </div>
    </main>
  );
}

function Metric({ label, value, detail }: { readonly label: string; readonly value: string; readonly detail: string }) {
  return <div className="mission-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
