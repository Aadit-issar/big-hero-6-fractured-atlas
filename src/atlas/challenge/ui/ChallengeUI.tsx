import type { CSSProperties } from 'react';
import type { FilmBeat } from '../director';
import type { Film, SegmentId } from '../film';
import type { EvidenceSection } from './evidence';
import type { ClearanceChart, ModelChart } from '../chartData';
import { ClearanceChartView, ModelChartView } from './Charts';
import './challenge.css';

const STAGES = ['PROBLEM', 'OBSERVE', 'MODEL', 'PLAN', 'VERIFY'] as const;
const STAGE_OF: Record<SegmentId, number> = { intro: 0, reveal: 0, observe: 1, model: 2, verify: 2, problem: 3, conflict: 3, calculate: 3, fly: 3, adapt: 3, arrive: 4, proof: 4, close: 4 };
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}`;

export interface CaptionCue { readonly from: number; readonly to: number; readonly text: string }

export interface ChallengeUIProps {
  readonly beat: FilmBeat;
  readonly film: Film;
  readonly clock: number;
  readonly playing: boolean;
  readonly interactive: boolean;
  readonly evidence: readonly EvidenceSection[];
  readonly modelChart: ModelChart | null;
  readonly clearanceChart: ClearanceChart | null;
  readonly evidenceOpen: boolean;
  readonly manual: boolean;
  readonly labels: readonly { key: string; text: string; sub?: string | undefined; tone: string }[];
  readonly labelLayer: { current: HTMLDivElement | null };
  readonly cues: readonly CaptionCue[];
  readonly showCaptions: boolean;
  readonly speed: number;
  readonly onPlay: () => void;
  readonly onRestart: () => void;
  readonly onSeek: (clock: number) => void;
  readonly onSpeed: (s: number) => void;
  readonly onEvidence: () => void;
  readonly onResume: () => void;
}

export function ChallengeUI(p: ChallengeUIProps) {
  const { beat, film, clock } = p;
  const seg = film.segments.find(s => s.id === beat.segment)!;
  const len = seg.to - seg.from;
  // Captions enter and leave on the film clock (no CSS animation), so a captured film is exact.
  const inA = smooth(beat.u / 0.7), outA = 1 - smooth((beat.u - (len - 0.7)) / 0.7);
  const alpha = Math.min(inA, outA);
  const stage = STAGE_OF[beat.segment];
  const cue = p.showCaptions ? p.cues.find(c => clock >= c.from && clock < c.to) : undefined;
  const cueAlpha = cue ? Math.min(smooth((clock - cue.from) / 0.25), 1 - smooth((clock - (cue.to - 0.25)) / 0.25)) : 0;
  const title = beat.segment === 'intro';
  return (
    <div className="ch-ui" data-testid="challenge-ui" data-segment={beat.segment} data-mode={beat.mode}>
      <div className="ch-shade" style={{ opacity: beat.shade }} />
      <div className="ch-vignette" />
      <header className="ch-top">
        <div className="ch-brand"><b>BIG HERO 6</b><span>FRACTURED</span><i /><b>ATLAS</b></div>
        <div className="ch-tag" title="Obstacle motion is real Dimension island motion replayed in a controlled simulated scenario. It is not a capture of the live world.">CONTROLLED MATHEMATICAL CHALLENGE · simulated scenario</div>
      </header>
      {(p.modelChart || p.clearanceChart) && (
        <div className="ch-chartpanel">
          {p.modelChart && <ModelChartView data={p.modelChart} u={beat.segment === 'verify' ? beat.u + 6 : beat.u} alpha={alpha} />}
          {p.clearanceChart && <ClearanceChartView data={p.clearanceChart} u={beat.segment === 'conflict' ? beat.u : beat.segment === 'calculate' ? beat.u : 9} alpha={alpha} showChosen={beat.layers.chosen} showConflict={beat.segment !== 'calculate' || true} />}
        </div>
      )}
      <div className="ch-labels" ref={p.labelLayer}>
        {p.labels.map(l => <div key={l.key} data-key={l.key} className={`ch-label ch-${l.tone}`}><span>{l.text}</span>{l.sub && <small>{l.sub}</small>}</div>)}
      </div>
      <section className={`ch-caption ${title ? 'ch-title' : ''}`} style={{ opacity: alpha, transform: `translateY(${(1 - alpha) * 10}px)` }} aria-live="polite" data-testid="challenge-caption">
        {beat.kicker && <p className="ch-kicker">{beat.kicker}</p>}
        {beat.headline && <h1>{beat.headline}</h1>}
        {beat.line && <p className="ch-line">{beat.line}</p>}
        {beat.chips.length > 0 && <ul className="ch-chips">{beat.chips.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      </section>
      {cue && <div className="ch-subtitle" style={{ opacity: cueAlpha }} data-testid="challenge-subtitle">{cue.text}</div>}
      <nav className="ch-stages" aria-label="Progress">
        {STAGES.map((s, i) => <span key={s} aria-current={i === stage ? 'step' : undefined} data-done={i < stage ? '1' : '0'}>{s}</span>)}
        <i style={{ width: `${(clock / film.duration) * 100}%` } as CSSProperties} />
      </nav>
      {p.interactive && (
        <div className="ch-controls">
          <button onClick={p.onPlay} aria-label={p.playing ? 'Pause' : 'Play'}>{p.playing ? 'Ⅱ' : '▶'}</button>
          <button onClick={p.onRestart} aria-label="Restart">↺</button>
          <span data-testid="challenge-clock">{mmss(clock)} / {mmss(film.duration)}</span>
          <input type="range" min={0} max={film.duration} step={0.05} value={clock} aria-label="Film timeline" onChange={e => p.onSeek(Number(e.target.value))} />
          <select aria-label="Speed" value={p.speed} onChange={e => p.onSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}×</option>)}</select>
          <button onClick={p.onEvidence} aria-pressed={p.evidenceOpen} data-testid="evidence-toggle">Evidence</button>
          {p.manual && <button onClick={p.onResume}>Directed camera</button>}
        </div>
      )}
      {p.interactive && p.evidenceOpen && (
        <aside className="ch-evidence" data-testid="evidence-panel">
          <h2>Evidence</h2>
          {p.evidence.map(s => (
            <section key={s.title}><h3>{s.title}</h3><dl>{s.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></section>
          ))}
        </aside>
      )}
    </div>
  );
}
