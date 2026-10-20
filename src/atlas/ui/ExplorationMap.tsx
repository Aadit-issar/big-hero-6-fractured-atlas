import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { FoldMemoryRecord, IslandMemoryRecord, ExplorationMapSnapshot, PositionSample } from '../mapping/explorationMemory';
import { projectWorldPosition, worldDistance3D, type MapProjection } from '../mapping/projection';
import type { WorldVec3 } from '../../shared/atlasContract';
import type { SensorStatus } from '../core/runtime';

type Projection = MapProjection;
type Selection = { readonly kind: 'island' | 'fold'; readonly id: string };
interface Camera { readonly horizontal: number; readonly vertical: number; readonly scale: number }
type HistoricalSelection =
  | { readonly kind: 'island'; readonly id: string; readonly time: number; readonly position: WorldVec3 }
  | { readonly kind: 'fold'; readonly id: string; readonly time: number; readonly entry: WorldVec3; readonly exit: WorldVec3 };

const WIDTH = 800;
const HEIGHT = 460;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const MIN_SCALE = 0.15;
const MAX_SCALE = 14;

const project = projectWorldPosition;

function screen(position: WorldVec3, camera: Camera, projection: Projection): readonly [number, number] {
  const [horizontal, vertical] = project(position, projection);
  return [CENTER_X + (horizontal - camera.horizontal) * camera.scale, CENTER_Y - (vertical - camera.vertical) * camera.scale];
}

function format(value: number): string { return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value).toFixed(1) : 'unknown'; }
function formatPosition(position: WorldVec3): string { return 'X ' + format(position[0]) + ' · Y ' + format(position[1]) + ' · Z ' + format(position[2]); }
function worldPoints(map: ExplorationMapSnapshot): WorldVec3[] {
  const points: WorldVec3[] = [];
  for (const island of map.islands) {
    points.push(island.firstPosition, island.lastKnownPosition);
    for (const sample of island.track) points.push(sample.position);
  }
  for (const fold of map.folds) points.push(fold.firstEntryPosition, fold.firstExitPosition, fold.lastKnownEntryPosition, fold.lastKnownExitPosition);
  for (const sample of map.explorer.track) points.push(sample.position);
  return points;
}

function fitCamera(map: ExplorationMapSnapshot, projection: Projection): Camera {
  const points = worldPoints(map);
  if (points.length === 0) {
    const position = map.explorer.latestPosition ?? [0, 0, 0] as WorldVec3;
    const [horizontal, vertical] = project(position, projection);
    return { horizontal, vertical, scale: 3.5 };
  }
  let horizontalMin = Number.POSITIVE_INFINITY;
  let horizontalMax = Number.NEGATIVE_INFINITY;
  let verticalMin = Number.POSITIVE_INFINITY;
  let verticalMax = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const [horizontal, vertical] = project(point, projection);
    horizontalMin = Math.min(horizontalMin, horizontal);
    horizontalMax = Math.max(horizontalMax, horizontal);
    verticalMin = Math.min(verticalMin, vertical);
    verticalMax = Math.max(verticalMax, vertical);
  }
  const horizontalSpan = Math.max(1, horizontalMax - horizontalMin);
  const verticalSpan = Math.max(1, verticalMax - verticalMin);
  return {
    horizontal: (horizontalMin + horizontalMax) / 2,
    vertical: (verticalMin + verticalMax) / 2,
    scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, (WIDTH - 100) / horizontalSpan, (HEIGHT - 90) / verticalSpan)),
  };
}

function segments(track: readonly PositionSample[]): PositionSample[][] {
  const output: PositionSample[][] = [];
  for (const sample of track) {
    if (sample.breakBefore || output.length === 0) output.push([sample]);
    else output[output.length - 1]?.push(sample);
  }
  return output;
}

function gridStep(scale: number): number {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 250, 500];
  return candidates.reduce((best, value) => Math.abs(value * scale - 72) < Math.abs(best * scale - 72) ? value : best, candidates[0]!);
}

export function ExplorationMap({ map, selected, onSelect, sensorStatus }: {
  readonly map: ExplorationMapSnapshot;
  readonly selected: string;
  readonly onSelect: (selection: Selection) => void;
  readonly sensorStatus: SensorStatus;
}) {
  const [projection, setProjection] = useState<Projection>('xz');
  const [follow, setFollow] = useState(true);
  const [showIslands, setShowIslands] = useState(true);
  const [showFolds, setShowFolds] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [showHistorical, setShowHistorical] = useState(true);
  const [historicalSelection, setHistoricalSelection] = useState<HistoricalSelection | null>(null);
  const [camera, setCamera] = useState<Camera>(() => {
    const position = map.explorer.latestPosition ?? [0, 0, 0] as WorldVec3;
    const [horizontal, vertical] = project(position, 'xz');
    return { horizontal, vertical, scale: 3.5 };
  });
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!follow || !map.explorer.latestPosition) return;
    const [horizontal, vertical] = project(map.explorer.latestPosition, projection);
    setCamera((previous) => ({ ...previous, horizontal, vertical }));
  }, [follow, map.explorer.latestPosition, projection]);

  const choose = (kind: Selection['kind'], id: string) => onSelect({ kind, id });
  const selectedIsland = selected.startsWith('island:') ? map.islands.find((entry) => entry.id === selected.slice(7)) : undefined;
  const selectedFold = selected.startsWith('fold:') ? map.folds.find((entry) => entry.id === selected.slice(5)) : undefined;
  const step = gridStep(camera.scale);
  const centerHorizontal = camera.horizontal;
  const centerVertical = camera.vertical;
  const left = centerHorizontal - CENTER_X / camera.scale;
  const right = centerHorizontal + CENTER_X / camera.scale;
  const bottom = centerVertical - (HEIGHT - CENTER_Y) / camera.scale;
  const top = centerVertical + CENTER_Y / camera.scale;
  const firstGridX = Math.ceil(left / step) * step;
  const firstGridY = Math.ceil(bottom / step) * step;
  const xGrid: number[] = [];
  const yGrid: number[] = [];
  for (let value = firstGridX; value <= right && xGrid.length < 60; value += step) xGrid.push(value);
  for (let value = firstGridY; value <= top && yGrid.length < 60; value += step) yGrid.push(value);

  const pointerPosition = (clientX: number, clientY: number, svg: SVGSVGElement): readonly [number, number] => {
    const bounds = svg.getBoundingClientRect();
    return [(clientX - bounds.left) * WIDTH / bounds.width, (clientY - bounds.top) * HEIGHT / bounds.height];
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.exploration-map-object')) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setFollow(false);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - drag.current.x) * WIDTH / bounds.width;
    const dy = (event.clientY - drag.current.y) * HEIGHT / bounds.height;
    drag.current = { ...drag.current, x: event.clientX, y: event.clientY };
    setCamera((previous) => ({ ...previous, horizontal: previous.horizontal - dx / previous.scale, vertical: previous.vertical + dy / previous.scale }));
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const [px, py] = pointerPosition(event.clientX, event.clientY, event.currentTarget);
    setCamera((previous) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous.scale * Math.exp(-event.deltaY * 0.0012)));
      const horizontalAtPointer = previous.horizontal + (px - CENTER_X) / previous.scale;
      const verticalAtPointer = previous.vertical - (py - CENTER_Y) / previous.scale;
      return {
        horizontal: horizontalAtPointer - (px - CENTER_X) / scale,
        vertical: verticalAtPointer + (py - CENTER_Y) / scale,
        scale,
      };
    });
  };
  const setFollowExplorer = () => {
    setFollow(true);
    if (map.explorer.latestPosition) {
      const [horizontal, vertical] = project(map.explorer.latestPosition, projection);
      setCamera((previous) => ({ ...previous, horizontal, vertical }));
    }
  };
  const inspectHistoricalSelection = (selection: HistoricalSelection) => {
    setHistoricalSelection(selection);
    setFollow(false);
    const position = selection.kind === 'island' ? selection.position : selection.entry;
    const [horizontal, vertical] = project(position, projection);
    setCamera((previous) => ({ ...previous, horizontal, vertical }));
  };
  const fit = () => { setFollow(false); setCamera(fitCamera(map, projection)); };
  const resetCamera = () => {
    const position = map.explorer.latestPosition ?? [0, 0, 0] as WorldVec3;
    const [horizontal, vertical] = project(position, projection);
    setCamera({ horizontal, vertical, scale: 3.5 });
  };
  const adjustZoom = (factor: number) => setCamera((previous) => ({ ...previous, scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous.scale * factor)) }));
  const projectionTitle = projection === 'xz' ? 'TOP-DOWN · WORLD X / Z' : 'SIDE ELEVATION · WORLD Z / Y';
  const held = sensorStatus === 'stale' || sensorStatus === 'invalid' || sensorStatus === 'unavailable';

  return (
    <section className="panel exploration-panel" aria-labelledby="exploration-title" data-testid="exploration-map">
      <div className="panel-heading exploration-heading">
        <div><p className="eyebrow">SESSION MEMORY · SENSOR EVIDENCE</p><h2 id="exploration-title">Exploration map</h2></div>
        <div className="exploration-readout"><span>{projectionTitle}</span><strong>{map.latestSimulationTime === null ? 'AWAITING OBSERVATION' : 'SIM ' + format(map.latestSimulationTime) + ' S'}</strong></div>
      </div>
      <div className="map-summary" aria-label="Exploration summary">
        <div><span>UNIQUE ISLANDS</span><strong>{map.summary.uniqueIslands}</strong><small>{map.summary.currentlyObservedIslands} current · {map.summary.previouslyObservedIslands} prior</small></div>
        <div><span>FOLD RECORDS</span><strong>{map.summary.uniqueFolds}</strong><small>{map.summary.currentlyObservedFolds} current · {map.summary.historicalFolds} historical</small></div>
        <div><span>EXPLORER SAMPLES</span><strong>{map.summary.distinctExplorerSamples}</strong><small>{map.summary.explorerTrackLength} retained · {format(map.summary.explorerSampledDisplacement)} sampled displacement</small></div>
        <div><span>MAP SESSION</span><strong>{String(map.session).padStart(2, '0')}</strong><small>{map.summary.evictedEntityRecords ? map.summary.evictedEntityRecords + ' old records evicted at memory limit' : 'active · bounded memory'}</small></div>
      </div>
      <div className="map-toolbar" aria-label="Exploration map controls">
        <div className="map-control-group" role="group" aria-label="Map projection">
          <button type="button" aria-pressed={projection === 'xz'} onClick={() => setProjection('xz')}>Top-down X/Z</button>
          <button type="button" aria-pressed={projection === 'zy'} onClick={() => setProjection('zy')}>Elevation Z/Y</button>
        </div>
        <div className="map-control-group map-camera-controls" role="group" aria-label="Map camera controls">
          <button type="button" onClick={fit}>Fit observations</button>
          <button type="button" aria-pressed={follow} onClick={setFollowExplorer}>Follow explorer</button>
          <button type="button" onClick={resetCamera}>Reset camera</button>
          <button type="button" aria-label="Zoom out" onClick={() => adjustZoom(0.8)}>−</button>
          <button type="button" aria-label="Zoom in" onClick={() => adjustZoom(1.25)}>+</button>
        </div>
      </div>
      {held && <div className="map-held-warning" role="status">Map membership reflects the last accepted observation. Current delivery is {sensorStatus}; stored world state has not been refreshed.</div>}
      <div className="map-layout">
        <div className="map-canvas-wrap">
          <svg
            ref={svgRef}
            className="exploration-canvas"
            viewBox={'0 0 ' + WIDTH + ' ' + HEIGHT}
            role="application"
            aria-label={projection === 'xz' ? 'Accumulated world-aligned map using X and Z coordinates; drag to pan and scroll to zoom' : 'Accumulated side elevation map using world Z and Y coordinates; drag to pan and scroll to zoom'}
            data-testid="exploration-canvas"
            data-scale={camera.scale}
            data-camera-horizontal={camera.horizontal}
            data-camera-vertical={camera.vertical}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          >
            <defs>
              <pattern id="atlas-map-dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="#46606b" opacity="0.32" /></pattern>
            </defs>
            <rect className="map-background" x="0" y="0" width={WIDTH} height={HEIGHT} fill="url(#atlas-map-dots)" />
            <g className="map-grid">
              {xGrid.map((coordinate) => { const x = CENTER_X + (coordinate - camera.horizontal) * camera.scale; return <line key={'x' + coordinate} x1={x} x2={x} y1="0" y2={HEIGHT} />; })}
              {yGrid.map((coordinate) => { const y = CENTER_Y - (coordinate - camera.vertical) * camera.scale; return <line key={'y' + coordinate} x1="0" x2={WIDTH} y1={y} y2={y} />; })}
            </g>
            <line className="map-axis" x1={0} x2={WIDTH} y1={CENTER_Y + camera.vertical * camera.scale} y2={CENTER_Y + camera.vertical * camera.scale} />
            <line className="map-axis" x1={CENTER_X - camera.horizontal * camera.scale} x2={CENTER_X - camera.horizontal * camera.scale} y1={0} y2={HEIGHT} />
            {showTrail && segments(map.explorer.track).map((segment, index) => segment.length > 1 && <polyline key={'trail-' + index} className="map-explorer-trail" points={segment.map((sample) => screen(sample.position, camera, projection).join(',')).join(' ')} />)}

            {showFolds && map.folds.filter((fold) => fold.currentlyObserved || showHistorical).map((fold) => {
              const entry = screen(fold.lastKnownEntryPosition, camera, projection);
              const exit = screen(fold.lastKnownExitPosition, camera, projection);
              const chosen = selected === 'fold:' + fold.id;
              return <g key={'fold-' + fold.id} className={'exploration-map-object map-fold ' + (fold.currentlyObserved ? 'map-current' : 'map-historical') + (chosen ? ' map-selected' : '')} role="group" aria-label={'Fold ' + fold.id + ', last observed ' + fold.lastObservedState + (fold.currentlyObserved ? ', currently observed' : ', current state unknown')} data-testid={'map-fold-' + fold.id} onClick={() => choose('fold', fold.id)}>
                <title>{fold.id + ' · ' + (fold.currentlyObserved ? 'currently observed ' + fold.currentState : 'last observed ' + fold.lastObservedState + ' at ' + format(fold.lastSeenAt) + ' s') + ' · endpoint relation is abstract, not a physical route'}</title>
                <line className="map-fold-relation" x1={entry[0]} y1={entry[1]} x2={exit[0]} y2={exit[1]} />
                <path className="map-fold-entry exploration-map-object" d={'M ' + entry[0] + ' ' + (entry[1] - 7) + ' L ' + (entry[0] + 7) + ' ' + entry[1] + ' L ' + entry[0] + ' ' + (entry[1] + 7) + ' L ' + (entry[0] - 7) + ' ' + entry[1] + ' Z'} role="button" tabIndex={0} aria-label={'Select fold ' + fold.id + ' entry'} data-testid={'map-fold-' + fold.id + '-entry'} onClick={() => choose('fold', fold.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose('fold', fold.id); } }} />
                <circle className="map-fold-exit exploration-map-object" cx={exit[0]} cy={exit[1]} r="5" role="button" tabIndex={0} aria-label={'Select fold ' + fold.id + ' reported exit'} onClick={() => choose('fold', fold.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose('fold', fold.id); } }} />
                {chosen && <text className="map-marker-label" x={entry[0] + 10} y={entry[1] - 9}>{fold.id}</text>}
              </g>;
            })}

            {showIslands && map.islands.filter((island) => island.currentlyObserved || showHistorical).map((island) => {
              const point = screen(island.lastKnownPosition, camera, projection);
              const chosen = selected === 'island:' + island.id;
              const history = island.track.slice(-16);
              return <g key={'island-' + island.id} className={'exploration-map-object map-island ' + (island.currentlyObserved ? 'map-current' : 'map-historical') + (chosen ? ' map-selected' : '')} role="button" tabIndex={0} aria-label={'Select island ' + island.id + (island.currentlyObserved ? ', currently observed' : ', previously observed; current position unknown')} data-testid={'map-island-' + island.id} onClick={() => choose('island', island.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose('island', island.id); } }}>
                <title>{island.id + ' · ' + formatPosition(island.lastKnownPosition) + ' · ' + (island.currentlyObserved ? 'current observation' : 'last observed at ' + format(island.lastSeenAt) + ' s')}</title>
                {segments(history).filter((segment) => segment.length > 1).map((segment, index) => <polyline key={'island-track-' + index} className="map-island-track" points={segment.map((sample) => screen(sample.position, camera, projection).join(',')).join(' ')} />)}
                {island.currentlyObserved ? <circle className="map-island-marker" cx={point[0]} cy={point[1]} r={chosen ? 8 : 6} /> : <rect className="map-island-marker map-historical-marker" x={point[0] - 5.5} y={point[1] - 5.5} width="11" height="11" />}
                {chosen && <text className="map-marker-label" x={point[0] + 10} y={point[1] - 9}>{island.id}</text>}
              </g>;
            })}

            {map.explorer.latestPosition && (() => {
              const point = screen(map.explorer.latestPosition, camera, projection);
              return <g className="map-explorer-current" aria-label={'Latest observed explorer position ' + formatPosition(map.explorer.latestPosition)}><circle cx={point[0]} cy={point[1]} r="10" /><circle cx={point[0]} cy={point[1]} r="3" /><text x={point[0] + 12} y={point[1] + 4}>BAYMAX</text></g>;
            })()}

            {historicalSelection?.kind === 'island' && (() => {
              const point = screen(historicalSelection.position, camera, projection);
              return <g className="map-history-focus" aria-label={'Selected historical island sample at simulation time ' + format(historicalSelection.time) + ' seconds'} data-testid="historical-sample-highlight"><circle cx={point[0]} cy={point[1]} r="14" /><line x1={point[0] - 18} x2={point[0] + 18} y1={point[1]} y2={point[1]} /><line x1={point[0]} x2={point[0]} y1={point[1] - 18} y2={point[1] + 18} /><text x={point[0] + 17} y={point[1] - 14}>SIM {format(historicalSelection.time)} S</text></g>;
            })()}
            {historicalSelection?.kind === 'fold' && (() => {
              const entry = screen(historicalSelection.entry, camera, projection);
              const exit = screen(historicalSelection.exit, camera, projection);
              return <g className="map-history-focus" aria-label={'Selected historical fold sample at simulation time ' + format(historicalSelection.time) + ' seconds'} data-testid="historical-sample-highlight"><line className="map-history-focus-relation" x1={entry[0]} y1={entry[1]} x2={exit[0]} y2={exit[1]} /><circle cx={entry[0]} cy={entry[1]} r="12" /><circle cx={exit[0]} cy={exit[1]} r="10" /><text x={entry[0] + 14} y={entry[1] - 13}>SIM {format(historicalSelection.time)} S</text></g>;
            })()}

            <text className="map-axis-caption" x="16" y="24">{projection === 'xz' ? 'WORLD X / Z · WORLD ALIGNED' : 'SIDE ELEVATION · WORLD Z / Y'}</text>
            <text className="map-axis-caption map-axis-horizontal" x={WIDTH - 16} y={HEIGHT - 14} textAnchor="end">{projection === 'xz' ? 'X →' : 'Z →'}</text>
            <text className="map-axis-caption" x="16" y={HEIGHT - 14}>{projection === 'xz' ? '↑ Z' : '↑ Y'}</text>
            <g className="map-scale" transform="translate(24 55)"><line x1="0" x2={Math.min(120, 25 * camera.scale)} y1="0" y2="0" /><line x1="0" x2="0" y1="-4" y2="4" /><line x1={Math.min(120, 25 * camera.scale)} x2={Math.min(120, 25 * camera.scale)} y1="-4" y2="4" /><text x="0" y="15">{format(Math.min(120 / camera.scale, 25))} WORLD UNITS</text></g>
            {map.islands.length === 0 && map.folds.length === 0 && <g className="map-empty-state"><rect x="190" y="170" width="420" height="104" rx="6" /><text x="400" y="211" textAnchor="middle">NO ACCUMULATED DISCOVERIES</text><text x="400" y="239" textAnchor="middle">Map entities appear after accepted sensor observations.</text></g>}
          </svg>
          <div className="map-canvas-help"><span>DRAG TO PAN</span><span>SCROLL TO ZOOM</span><span>NO UNOBSERVED WORLD DATA</span></div>
        </div>
        <aside className="map-inspector" aria-label="Exploration entity inspector" data-testid="map-inspector">
          <div className="map-inspector-head"><p className="eyebrow">EVIDENCE RECORD</p><strong>{selectedIsland?.id ?? selectedFold?.id ?? 'No selection'}</strong></div>
          {selectedIsland ? <IslandInspector island={selectedIsland} explorer={map.explorer.latestPosition} onInspect={(sample) => inspectHistoricalSelection({ kind: 'island', id: selectedIsland.id, time: sample.time, position: sample.position })} /> : selectedFold ? <FoldInspector fold={selectedFold} onInspect={(sample) => inspectHistoricalSelection({ kind: 'fold', id: selectedFold.id, time: sample.time, entry: sample.entryPosition, exit: sample.exitPosition })} /> : <p className="map-inspector-empty">Select a remembered island or fold marker. The map stores observed coordinates and connection evidence only.</p>}
          <div className="map-layer-controls" aria-label="Map layers">
            <p className="eyebrow">VISIBLE LAYERS</p>
            <label><input type="checkbox" checked={showIslands} onChange={(event) => setShowIslands(event.target.checked)} /> Islands</label>
            <label><input type="checkbox" checked={showFolds} onChange={(event) => setShowFolds(event.target.checked)} /> Fold relations</label>
            <label><input type="checkbox" checked={showTrail} onChange={(event) => setShowTrail(event.target.checked)} /> Explorer trail</label>
            <label><input type="checkbox" checked={showHistorical} onChange={(event) => setShowHistorical(event.target.checked)} /> Historical entities</label>
          </div>
        </aside>
      </div>
      <div className="map-legend" aria-label="Map legend">
        <span><i className="legend-map-explorer" />Explorer sample</span>
        <span><i className="legend-map-island" />Current island observation</span>
        <span><i className="legend-map-history" />Historical last-known position</span>
        <span><i className="legend-map-fold" />Reported fold relation · abstract, not a physical route</span>
        <span className="map-freshness-note">Absent from the latest sensor set means current state unknown, not destroyed or closed.</span>
      </div>
      <p className="panel-footnote exploration-footnote">World coordinates are time-varying measurements. X/Z is the default horizontal projection; elevation mode shows Z/Y. A fold exit is sensor-reported and is not evidence that Baymax explored the destination. Selecting a history sample focuses that recorded point; it does not reconstruct a complete world snapshot. Display freshness threshold: 5 simulation seconds; simulation pause does not age records.</p>
    </section>
  );
}

function IslandInspector({ island, explorer, onInspect }: { readonly island: IslandMemoryRecord; readonly explorer: WorldVec3 | null; readonly onInspect: (sample: PositionSample) => void }) {
  const verticalDelta = explorer && island.currentPosition ? island.currentPosition[1] - explorer[1] : null;
  const distance = explorer && island.currentPosition ? worldDistance3D(island.currentPosition, explorer) : null;
  return <div className="map-inspector-body">
    <span className={'map-status-chip ' + (island.currentlyObserved ? 'is-current' : 'is-historical')}>{island.currentlyObserved ? 'CURRENTLY OBSERVED' : island.freshness === 'stale' ? 'HISTORICAL · STALE' : 'PREVIOUSLY OBSERVED'}</span>
    <Detail label="First seen" value={format(island.firstSeenAt) + ' s'} />
    <Detail label="Last seen" value={format(island.lastSeenAt) + ' s'} />
    <Detail label="Current status" value={island.currentlyObserved ? 'Present in latest accepted sample' : 'Not present in latest sample; current state unknown'} />
    <Detail label={island.currentlyObserved ? 'Observed position' : 'Last known position'} value={formatPosition(island.lastKnownPosition)} />
    <Detail label="Accepted sightings" value={String(island.observationCount)} />
    <Detail label="Position samples" value={String(island.track.length) + ' retained'} />
    {verticalDelta !== null && <Detail label="Height vs explorer" value={(verticalDelta >= 0 ? '+' : '') + format(verticalDelta) + ' world units'} />}
    {distance !== null && <Detail label="Current 3D separation" value={format(distance) + ' world units'} />}
    <p className="map-history-heading">RECORDED POSITION SAMPLES · SELECT TO INSPECT</p>
    <div className="map-history-list">{island.track.slice(-8).reverse().map((sample) => <button key={sample.time} type="button" data-testid={'map-history-island-' + island.id + '-' + sample.time} onClick={() => onInspect(sample)}><strong>SIM {format(sample.time)} S</strong><span>{formatPosition(sample.position)}</span><small>{sample.breakBefore ? 'segment break · no path assumed' : 'sensor sample'}</small></button>)}</div>
    {!island.currentlyObserved && <p className="inspector-caveat">Historical coordinate only. Current island position and distance are unavailable.</p>}
  </div>;
}

function FoldInspector({ fold, onInspect }: { readonly fold: FoldMemoryRecord; readonly onInspect: (sample: FoldMemoryRecord['track'][number]) => void }) {
  return <div className="map-inspector-body">
    <span className={'map-status-chip ' + (fold.currentlyObserved ? 'is-current' : 'is-historical')}>{fold.currentlyObserved ? 'CURRENTLY OBSERVED' : fold.freshness === 'stale' ? 'HISTORICAL · STALE' : 'PREVIOUSLY OBSERVED'}</span>
    <Detail label="First seen" value={format(fold.firstSeenAt) + ' s'} />
    <Detail label="Last seen" value={format(fold.lastSeenAt) + ' s'} />
    <Detail label="Current state" value={fold.currentlyObserved ? (fold.currentState ?? 'unknown') : 'Unknown · not in latest observation'} />
    <Detail label="Last observed state" value={fold.lastObservedState} />
    <Detail label="Entry position" value={formatPosition(fold.lastKnownEntryPosition)} />
    <Detail label="Sensor-reported exit" value={formatPosition(fold.lastKnownExitPosition)} />
    <Detail label="Accepted sightings" value={String(fold.observationCount)} />
    <Detail label="Directionality" value="Unknown from contract" />
    <Detail label="Destination evidence" value="Endpoint reported; not independently explored" />
    <p className="map-history-heading">RECORDED FOLD OBSERVATIONS · SELECT TO INSPECT</p>
    <div className="map-history-list">{fold.track.slice(-8).reverse().map((sample) => <button key={sample.time} type="button" data-testid={'map-history-fold-' + fold.id + '-' + sample.time} onClick={() => onInspect(sample)}><strong>SIM {format(sample.time)} S · {sample.state.toUpperCase()}</strong><span>Entry {formatPosition(sample.entryPosition)}</span><small>Exit {formatPosition(sample.exitPosition)}</small></button>)}</div>
    <p className="inspector-caveat">The dashed relation is an abstract sensor-reported fold, not a physical corridor, traversal-cost measurement, safety statement, or closure forecast.</p>
  </div>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="map-detail-row"><span>{label}</span><strong>{value}</strong></div>;
}
