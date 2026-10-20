import { useEffect, useRef, useState } from 'react';
import type { PanelProps } from './common';
import { Eyebrow, Evidence, Kv, TimeRail } from './common';
import { dist, encounterSummary, f0, f1, inSeconds, outcomeView, planBadge, routeChangeNote, routeStages, vec } from './logic';
import { positionAt } from '../../forecast';

/** Route planning: "where must Baymax go, and why?". Four compact sections: destination, predicted encounter, why this route, action. */
export function RoutePanel({ snap, session, scene }: PanelProps) {
  const target = snap.selectedId ? snap.targets.find(t => t.id === snap.selectedId) ?? null : null;
  const [compare, setCompare] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [flash, setFlash] = useState(0);
  const lastSpeed = useRef(snap.speed);
  useEffect(() => { if (lastSpeed.current !== snap.speed) { lastSpeed.current = snap.speed; setFlash(n => n + 1); } }, [snap.speed]);
  useEffect(() => { setCompare(false); setShowPlan(false); }, [target?.id]);

  if (!target) {
    return (
      <section className="card" data-testid="panel-route">
        <Eyebrow>Route planning</Eyebrow>
        <h2>Where must Baymax go?</h2>
        <p className="muted">Select a destination. ATLAS plans the route, and for a moving object it plans a meeting at a future time and place.</p>
      </section>
    );
  }

  const plan = snap.plan && snap.plan.targetId === target.id ? snap.plan : null;
  const route = snap.route;
  const mine = route.active?.targetId === target.id;
  const ready = plan?.status === 'ready';
  const live = mine && (route.state === 'accepted' || route.state === 'sent');
  const enc = snap.encounter && snap.encounter.entityId === target.id ? snap.encounter : null;
  const sum = enc ? encounterSummary(enc) : null;
  const badge = planBadge(plan?.mode ?? target.mode);
  const entity = snap.entities.find(e => e.id === target.id)!;
  const stages = mine ? routeStages(route) : null;
  const outcome = mine ? outcomeView(route) : null;
  const change = mine ? routeChangeNote(snap) : null;
  const est = snap.estimates.get(target.id);

  // Modelled comparison with flying straight to where the target was last seen (a model estimate, not a measurement).
  let chase: { time: number; miss: number } | null = null;
  if (ready && plan!.mode === 'intercept' && est?.fit && snap.pose) {
    const t = dist(snap.pose.position, plan!.targetNow) / plan!.speed;
    chase = { time: t, miss: dist(positionAt(est.fit, snap.simTime + t).position, plan!.targetNow) };
  }

  const preview = () => { const api = scene(); if (!api) return; if (plan?.mode === 'intercept') api.fitInterception(); else api.fitRoute(); };
  const problem = !ready && plan ? `${plan.status === 'unreachable' ? 'Cannot be reached at this speed. ' : plan.status === 'no-route' ? 'No clear route. ' : ''}${plan.reasons.join(' ')}` : null;

  return (
    <section className="card split route" data-testid="panel-route">
      <div className="card-body">
      {/* A. DESTINATION */}
      <div className="sec" data-testid="sec-destination">
        <Eyebrow>Destination</Eyebrow>
        <h2>{target.label}</h2>
        <p className="pills">
          <span className={`pill mode-${plan?.mode ?? target.mode}`} title={badge.hint} data-testid="plan-type">{badge.text}</span>
          <span className={`pill ${entity.knowledge}`}>{entity.knowledge === 'current' ? 'OBSERVED NOW' : `LAST KNOWN ${f0(target.age)} s AGO`}</span>
          <span className="pill plain">{entity.kind.toUpperCase()}</span>
        </p>
        <p className="muted small hide-short">Now at ({vec(entity.position)}){target.motion === 'moving' ? `, moving ${f1(target.speed ?? 0)} m/s` : ''}.</p>
        <label className="slider">Baymax speed <b data-testid="speed-value">{f0(snap.speed)} m/s</b>
          <input type="range" min={4} max={42} step={1} value={snap.speed} onChange={e => session.setSpeed(Number(e.target.value))} data-testid="speed" aria-label="Baymax speed" />
        </label>
        {flash > 0 && <span key={flash} className="recomputed" aria-live="polite">recomputed at {f0(snap.speed)} m/s</span>}
      </div>

      {problem && <p className="note warn" data-testid="plan-problem">{problem}</p>}

      {outcome && (
        <div className={`outcome ${outcome.success ? 'ok' : 'miss'}`} data-testid="route-outcome" data-success={outcome.success}>
          <b className="outcome-title">{outcome.title}</b>
          <dl className="kvs tight">{outcome.rows.map(r => <Kv key={r.k} k={r.k} v={r.v} tone={r.tone} />)}</dl>
          <p className="muted small">{outcome.note}</p>
          {!showPlan && <button type="button" className="link" onClick={() => setShowPlan(true)}>Show the plan</button>}
        </div>
      )}

      {ready && sum && enc && (!outcome || showPlan) && (
        <>
          {/* B. PREDICTED ENCOUNTER / APPROACH */}
          <div className={`sec encounter ${sum.moving ? 'moving' : ''} ${flash > 0 ? 'recomp' : ''}`} key={`enc-${flash}`} data-testid="sec-encounter">
            <Eyebrow>{sum.moving ? 'Predicted encounter' : 'Approach'}</Eyebrow>
            <div className="hero-time" data-testid="eta">
              <small>{sum.moving ? 'Baymax arrives and meets it' : 'Baymax arrives'}</small>
              <b>{sum.etaIn}</b>
              <span>t {f1(enc.arrivalTime)} s · route {f0(plan!.length!)} m</span>
            </div>
            <dl className="kvs tight">
              {sum.moving && <Kv k={`${enc.label} forecast for`} v={sum.sameTime ? `${sum.targetTimeIn} (same time)` : sum.targetTimeIn} testId="target-time" />}
              <Kv k={sum.moving ? 'Rendezvous at' : 'Approach point'} v={vec(sum.rendezvous)} testId="rendezvous" />
              {sum.moving && <Kv k="Ahead of where it is now" v={`${f0(sum.aheadOfNow)} m`} />}
              <Kv k="Forecast" v={sum.moving ? (enc.converged && !enc.leadLimited ? 'converged' : 'aim point only') : 'not needed'} tone={sum.moving && !(enc.converged && !enc.leadLimited) ? 'warn' : undefined} />
            </dl>
            <TimeRail now={enc.now} opts={{ eta: enc.arrivalTime, aim: sum.moving ? enc.aimTime : null }} testId="time-rail" />
            <p className="sentence" data-testid="intercept-line">{sum.sentence}</p>
            <p className="muted small hide-short">{sum.validity}</p>
          </div>

          {/* C. WHY THIS ROUTE */}
          <div className="sec why" data-testid="sec-why">
            <Eyebrow>Why this route</Eyebrow>
            <ul>{plan!.reasons.slice(0, 3).map(r => <li key={r}>{r}</li>)}</ul>
            {plan!.unknowns.length > 0 && <p className="note warn small">{plan!.unknowns[0]}</p>}
          </div>
        </>
      )}

      {compare && chase && enc && (
        <div className="compare" data-testid="compare">
          <Eyebrow>Chase versus intercept (model estimate)</Eyebrow>
          <dl className="kvs tight">
            <Kv k="Chase where it is now" v={`arrive ${inSeconds(snap.simTime + chase.time, snap.simTime)}; ~${f0(chase.miss)} m from it`} />
            <Kv k="Intercept" v={`arrive ${sum!.etaIn}; ${f1(enc.gap)} m from the forecast`} />
          </dl>
          <p className="muted small">Both figures come from ATLAS's own forecast, not from a measurement. The chase figure assumes the forecast is right.</p>
        </div>
      )}

      {chase && ready && <button type="button" className="link" onClick={() => setCompare(c => !c)} aria-expanded={compare} data-testid="compare-toggle">{compare ? 'Hide comparison' : 'Compare chase vs intercept'}</button>}
      <Evidence title="Evidence and details" testId="route-evidence">
        {plan && ready && (
          <dl className="kvs tight">
            <Kv k="Travel time" v={`${f1(plan.travelTime!)} s`} />
            <Kv k="Route length" v={`${f0(plan.length!)} m`} />
            <Kv k="Waypoints" v={plan.waypoints.length} />
            <Kv k={plan.mode === 'intercept' ? (plan.intercept?.leadLimited ? 'Aim point at' : 'Meeting at') : 'Arrival at'} v={`t ${f1(plan.meetingTime!)} s`} />
            <Kv k="Uncertainty" v={`±${f1(plan.uncertainty)} m`} />
          </dl>
        )}
        {plan && ready && <><h3>All reasons</h3><ul className="plain">{plan.reasons.map(r => <li key={r}>{r}</li>)}</ul></>}
        {plan && plan.unknowns.length > 0 && <><h3>Still unknown</h3><ul className="plain warn">{plan.unknowns.map(r => <li key={r}>{r}</li>)}</ul></>}
        {mine && route.history.length > 0 && <><h3>Route revisions</h3><ul className="plain history">{route.history.slice().reverse().map(h => <li key={h.revision}><b>r{h.revision}</b> t {f1(h.simTime)} s: {h.reason}</li>)}</ul></>}
        <label className="check"><input type="checkbox" checked={snap.autoReplan} onChange={e => session.setAutoReplan(e.target.checked)} /> Recalculate when observations change materially</label>
      </Evidence>
      </div>

      {/* D. ACTION */}
      <div className="sec action">
        {stages && (
          <div className={`strip ${stages.terminal ?? ''}`} data-testid="route-state" data-state={route.state}>
            <ol>{stages.steps.map(s => <li key={s.key} className={`${s.done ? 'done' : ''} ${s.current ? 'current' : ''}`}><i />{s.label}</li>)}</ol>
            {stages.progress != null && <div className="progress" role="progressbar" aria-valuenow={Math.round(stages.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${(stages.progress * 100).toFixed(0)}%` }} /></div>}
            <p className="muted small">{!snap.connected && <b className="warn">LINK LOST. </b>}{route.nav && stages.remaining != null && route.state !== 'arrived' && route.state !== 'missed' ? `${f0(stages.remaining)} m to go · waypoint ${Math.min(route.nav.activeIndex + 1, route.nav.waypointCount)} of ${route.nav.waypointCount}` : route.ackDetail}</p>
            {change && <p className={`change ${change.tone}`} data-testid="route-change">{change.text}</p>}
          </div>
        )}
        <div className="actions">
          <button type="button" className="primary big" disabled={!ready || !snap.connected} onClick={() => { if (session.sendRoute()) window.setTimeout(preview, 80); }} data-testid="send-route">{live ? 'Re-send to Baymax' : 'Send to Baymax'}</button>
          <button type="button" className="secondary" onClick={preview} disabled={!ready} data-testid="preview-route">Preview</button>
          {live && <button type="button" className="ghost" onClick={() => session.cancelRoute()} data-testid="cancel-route">Cancel</button>}
        </div>
      </div>


    </section>
  );
}
