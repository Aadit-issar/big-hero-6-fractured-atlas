import { useEffect, useRef, useState } from 'react';
import type { PanelProps } from './common';
import { Eyebrow, Evidence, Kv, TimeRail } from './common';
import { f0, f1, inSeconds, scrubReadout, validityOf, vec } from './logic';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Predictive analysis: "where will this object go?". Observed position and history, the model in plain words, a forecast PREVIEW scrubber
 * (never world playback), and frozen forecasts checked against what was later observed. */
export function PredictPanel({ snap, session, setView, scene }: PanelProps) {
  const target = snap.selectedId ? snap.targets.find(t => t.id === snap.selectedId) ?? null : null;
  const [offset, setOffset] = useState(0);
  const touched = useRef(false);

  // The preview is a read of the forecast at now + offset. It is cleared whenever this panel closes or the target changes.
  const id = target?.id ?? null;
  useEffect(() => { touched.current = false; setOffset(0); session.setScrubTime(null); return () => session.setScrubTime(null); }, [id, session]);
  const forecast = snap.forecast;
  useEffect(() => {
    if (!touched.current || !forecast) return;
    const r = scrubReadout(forecast, offset);
    session.setScrubTime(r.offset > 0.04 ? forecast.now + r.offset : null);
  }, [offset, forecast?.now, forecast?.trustedUntil, session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) {
    return (
      <section className="card" data-testid="panel-predict">
        <Eyebrow>Predictive analysis</Eyebrow>
        <h2>Where will it go?</h2>
        <p className="muted">Select a moving object. ATLAS shows what it has learned about its motion and where that motion leads.</p>
      </section>
    );
  }

  const entity = snap.entities.find(e => e.id === target.id)!;
  const est = snap.estimates.get(target.id);
  const track = session.memory.track(target.id);
  const first = track[0], last = track.at(-1);
  const fit = est?.fit ?? null;
  const val = fit?.validation ?? null;
  const heldOut = val ? (val.rmse[val.selected === 'quadratic' ? 'quadratic' : val.selected === 'linear' ? 'linear' : 'persistence'] ?? val.rmse.persistence) : null;
  const validity = validityOf({
    observations: track.length, span: first && last ? last.time - first.time : 0, evidenceAge: last ? Math.max(0, snap.simTime - last.time) : 0,
    ok: !!est?.ok, motion: est?.motion ?? 'unknown', model: fit ? `${fit.kind}${est?.speed != null ? `, about ${f1(est.speed)} m/s` : ''}` : null, note: est?.note ?? null,
    heldOutError: heldOut, baselineError: val ? val.rmse.persistence : null, leadSeconds: val ? val.leadSeconds : null,
  });
  const readout = forecast ? scrubReadout(forecast, offset) : null;
  const evaluated = snap.forecasts.map(f => ({ f, e: snap.evaluations.get(f.id) })).filter(x => x.e);
  const frozen = snap.forecasts.slice(-4).reverse();

  return (
    <section className="card split" data-testid="panel-predict">
      <div className="card-body">
      <Eyebrow>Predictive analysis</Eyebrow>
      <h2>{entity.label}</h2>
      <p className="pills"><span className={`pill ${entity.knowledge}`}>{entity.knowledge === 'current' ? 'OBSERVED NOW' : 'LAST KNOWN'}</span><span className={`pill ${validity.tone}`}>{validity.headline.toUpperCase()}</span></p>

      <dl className="kvs">
        <Kv k="Observed position" v={vec(entity.position)} />
        <Kv k="History" v={`${track.length} obs · ${first && last ? f1(last.time - first.time) : '0.0'} s`} />
        <Kv k="Evidence age" v={last ? `${f1(Math.max(0, snap.simTime - last.time))} s` : '—'} tone={last && snap.simTime - last.time > 1.5 ? 'warn' : undefined} />
      </dl>
      {!est?.ok && <p className="note warn" data-testid="no-forecast">No forecast yet: {est?.note ?? 'not enough observations.'} ATLAS will not guess; keep observing it.</p>}
      {est?.ok && est.motion !== 'moving' && <p className="note">It has not moved while observed, so there is nothing to forecast.</p>}
      {est?.ok && est.motion === 'moving' && val && (
        <p className="note" data-testid="validity">{validity.lines[2]}</p>
      )}

      {forecast && readout && (
        <div className="scrub" data-testid="scrubber">
          <div className="scrub-head"><span>FORECAST PREVIEW</span><b data-testid="scrub-label">{readout.label}</b></div>
          <input type="range" min={0} max={readout.max} step={0.1} value={readout.offset} onChange={e => { touched.current = true; setOffset(Number(e.target.value)); }} aria-label="Preview the forecast at a future time" data-testid="scrub" />
          <TimeRail now={forecast.now} opts={{ scrub: offset > 0.04 ? forecast.now + readout.offset : null, trustedUntil: forecast.trustedUntil }} />
          <dl className="kvs tight">
            <Kv k={offset > 0.04 ? `Predicted ${readout.label.toLowerCase()}` : 'Position now'} v={vec(offset > 0.04 ? readout.position : forecast.current.position)} testId="scrub-position" />
            <Kv k="Uncertainty" v={offset > 0.04 ? `±${f1(readout.uncertainty)} m` : 'observed'} />
          </dl>
          <p className="muted small">Forecast preview only: the world is not played forward.</p>
        </div>
      )}

      <div className="freeze" data-testid="freeze">
        <label className="slider inline">Freeze <b>{f0(snap.horizon)} s ahead</b>
          <input type="range" min={2} max={20} step={1} value={snap.horizon} onChange={e => session.setHorizon(Number(e.target.value))} data-testid="horizon" />
        </label>
        <button type="button" className="secondary" disabled={!est?.ok} onClick={() => session.freezeForecast()} data-testid="freeze-forecast">Freeze forecast</button>
      </div>

      {frozen.length > 0 ? (
        <div className="frozen" data-testid="frozen">
          <h3>Frozen forecasts checked against reality</h3>
          {evaluated.length > 0 && <p className="note" data-testid="forecast-summary">{evaluated.length} checked: average error <b>{f1(mean(evaluated.map(x => x.e!.error)))} m</b>, against <b>{f1(mean(evaluated.map(x => x.e!.baselineError)))} m</b> for "it has not moved".</p>}
          <ul>
            {frozen.map(f => {
              const e = snap.evaluations.get(f.id);
              return (
                <li key={f.id} className={e ? 'done' : 'pending'}>
                  <span>{f0(f.horizon)} s forecast, frozen at t {f1(f.issuedAt)} s</span>
                  {e
                    ? <b>forecast ({vec(f.position)}) → observed ({vec(e.observed)}) · off by {f1(e.error)} m</b>
                    : <b>{f.targetTime > snap.simTime ? `due ${inSeconds(f.targetTime, snap.simTime).toLowerCase()}` : 'awaiting an observation'}</b>}
                </li>
              );
            })}
          </ul>
        </div>
      ) : est?.ok && est.motion === 'moving' ? <p className="muted small">Forecasts are frozen automatically while a moving object is selected; they appear here once checked.</p> : null}

      <Evidence title="Evidence: model and equations">
        <dl className="kvs tight">
          <Kv k="Model" v={fit ? fit.kind : 'none'} />
          <Kv k="Fit residual" v={fit ? `${f1(fit.sigma)} m` : '—'} />
          <Kv k="Trusted until" v={forecast ? inSeconds(forecast.trustedUntil, forecast.now) : '—'} />
          <Kv k="Held-out error" v={heldOut != null ? `${f1(heldOut)} m` : '—'} />
        </dl>
        <p className="muted small">{validity.lines.join(' ')}</p>
        <p className="muted small">Position is x(t) = x0 + v (t − t0) {fit?.kind === 'quadratic' ? '+ ½ a (t − t0)² ' : ''}fitted by least squares to the observations; the uncertainty grows with lead time and is never smaller than the held-out error.</p>
      </Evidence>
      </div>
      <div className="sec action">
        <div className="actions">
        <button type="button" className="primary" onClick={() => setView('route')} data-testid="to-route">Plan interception</button>
        <button type="button" className="ghost" onClick={() => scene()?.fitPrediction()}>Fit view</button>
      </div>
      </div>
    </section>
  );
}
