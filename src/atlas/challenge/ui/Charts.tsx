import type { ClearanceChart, ModelChart, TP } from '../chartData';

const W = 760, H = 430, PAD = { l: 62, r: 26, t: 58, b: 52 };
const INK = '#f7ecff', DIM = '#c9b6e6', FAINT = '#8f7cb6', LILAC = '#f0b4f4', AMBER = '#ffb35c', WARM = '#fff2d2', GRID = 'rgba(228,103,230,.16)';
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const fade = (u: number, at: number, d = 0.7) => smooth((u - at) / d);

function scale(lo: number, hi: number, a: number, b: number) { const k = (b - a) / (hi - lo || 1); return (v: number) => a + (v - lo) * k; }
const path = (pts: readonly TP[], x: (t: number) => number, y: (v: number) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

function Frame({ title, sub, children, alpha }: { readonly title: string; readonly sub: string; readonly children: React.ReactNode; readonly alpha: number }) {
  return (
    <svg className="ch-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ opacity: alpha }}>
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} fill="rgba(5,4,40,.84)" stroke="rgba(228,103,230,.4)" />
      <text x="22" y="30" fill={LILAC} fontSize="13" letterSpacing="3.6" fontWeight="600">{title}</text>
      <text x="22" y="48" fill={DIM} fontSize="12.5">{sub}</text>
      {children}
    </svg>
  );
}

export function ModelChartView({ data, u, alpha }: { readonly data: ModelChart; readonly u: number; readonly alpha: number }) {
  const vals = [...data.samples.map(p => p.v), ...data.fitFuture.map(p => p.v), ...data.band.flatMap(b => [b.lo, b.hi]), data.persistence.v, data.estimate.v, ...(data.measured ? [data.measured.v] : [])];
  const lo = Math.min(...vals), hi = Math.max(...vals), padV = (hi - lo) * 0.14 || 1;
  const x = scale(data.t0, data.t1, PAD.l, W - PAD.r), y = scale(lo - padV, hi + padV, H - PAD.b, PAD.t);
  const ticks: number[] = []; for (let t = Math.ceil(data.t0); t <= data.t1; t += 2) ticks.push(t);
  const band = `${data.band.map((b, i) => `${i ? 'L' : 'M'}${x(b.t).toFixed(1)},${y(b.hi).toFixed(1)}`).join(' ')} ${[...data.band].reverse().map(b => `L${x(b.t).toFixed(1)},${y(b.lo).toFixed(1)}`).join(' ')} Z`;
  const m = data.measured;
  const ex = x(data.target);
  return (
    <Frame title="THE MODEL" sub="Position along the island’s direction of travel · seconds" alpha={alpha}>
      {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} stroke={GRID} /><text x={x(t)} y={H - PAD.b + 20} fill={FAINT} fontSize="12" textAnchor="middle">{t}</text></g>)}
      <line x1={x(data.issue)} x2={x(data.issue)} y1={PAD.t} y2={H - PAD.b} stroke={LILAC} strokeDasharray="3 5" opacity={0.55} />
      <text x={x(data.issue) - 6} y={PAD.t + 14} fill={DIM} fontSize="12" textAnchor="end">estimate frozen here</text>
      <path d={path(data.fitPast, x, y)} fill="none" stroke={LILAC} strokeWidth="2.4" opacity={fade(u, 1.2)} />
      <g opacity={fade(u, 3)}>
        <path d={band} fill="rgba(240,180,244,.16)" />
        <path d={path(data.fitFuture, x, y)} fill="none" stroke="#fff0ff" strokeWidth="2.6" strokeDasharray="1 0" />
      </g>
      {data.samples.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r="3.2" fill={p.t <= data.issue + 1e-9 ? '#b9a6e6' : WARM} opacity={p.t <= data.issue + 1e-9 ? 0.9 : 0.95} />)}
      <g opacity={fade(u, 4.5)}>
        <circle cx={ex} cy={y(data.estimate.v)} r={Math.max(5, (y(data.estimate.v - data.estimate.allowance) - y(data.estimate.v + data.estimate.allowance)) / 2)} fill="none" stroke={LILAC} strokeWidth="1.4" opacity="0.7" />
        <circle cx={ex} cy={y(data.estimate.v)} r="6" fill="#fff0ff" />
        <text x={ex - 12} y={y(data.estimate.v) - 14} fill={INK} fontSize="13" textAnchor="end">ATLAS estimate</text>
      </g>
      <g opacity={fade(u, 6.5)}>
        <line x1={x(data.issue)} x2={ex} y1={y(data.persistence.v)} y2={y(data.persistence.v)} stroke="#b7b0ff" strokeDasharray="5 5" opacity="0.8" />
        <circle cx={ex} cy={y(data.persistence.v)} r="6" fill="none" stroke="#c9c2ff" strokeWidth="2" />
        <text x={ex - 12} y={y(data.persistence.v) + 20} fill={DIM} fontSize="13" textAnchor="end">if it stayed put</text>
      </g>
      {m && (
        <g opacity={fade(u, 0.5)}>
          <line x1={ex + 10} x2={ex + 10} y1={y(m.v)} y2={y(data.estimate.v)} stroke={LILAC} strokeWidth="2" />
          <line x1={ex + 22} x2={ex + 22} y1={y(m.v)} y2={y(data.persistence.v)} stroke="#c9c2ff" strokeWidth="2" strokeDasharray="4 3" />
          <circle cx={ex} cy={y(m.v)} r="7.5" fill={WARM} />
          <text x={ex + 32} y={(y(m.v) + y(data.estimate.v)) / 2 + 4} fill={INK} fontSize="14" fontWeight="600">{m.modelError.toFixed(2)} u</text>
          <text x={ex + 32} y={(y(m.v) + y(data.persistence.v)) / 2 + 4} fill={DIM} fontSize="14">{m.persistenceError.toFixed(2)} u</text>
          <text x={ex - 12} y={y(m.v) + 4} fill={WARM} fontSize="13" textAnchor="end">measured</text>
        </g>
      )}
    </Frame>
  );
}

export function ClearanceChartView({ data, u, alpha, showChosen, showConflict }: { readonly data: ClearanceChart; readonly u: number; readonly alpha: number; readonly showChosen: boolean; readonly showConflict: boolean }) {
  const all = [...data.direct, ...data.chosen, ...data.required];
  const hi = Math.max(...all.map(p => p.v)) * 1.08, lo = 0;
  const x = scale(data.t0, data.t1, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const ticks: number[] = []; for (let t = Math.ceil(data.t0 / 4) * 4; t <= data.t1; t += 4) ticks.push(t);
  const req = path(data.required, x, y);
  const under = `${req} L${x(data.required.at(-1)!.t).toFixed(1)},${y(0)} L${x(data.required[0]!.t).toFixed(1)},${y(0)} Z`;
  return (
    <Frame title={data.title ?? 'THE CONSTRAINT'} sub={data.subtitle ?? `Predicted distance to ${data.obstacle}, Baymax’s centre to its centre · u · seconds`} alpha={alpha}>
      {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} stroke={GRID} /><text x={x(t)} y={H - PAD.b + 20} fill={FAINT} fontSize="12" textAnchor="middle">{t}</text></g>)}
      <path d={under} fill="rgba(255,179,92,.10)" />
      <path d={req} fill="none" stroke={AMBER} strokeWidth="1.8" strokeDasharray="7 5" />
      <text x={W - PAD.r - 4} y={y(data.required.at(-1)!.v) - 8} fill={AMBER} fontSize="12.5" textAnchor="end">{data.requiredLabel ?? 'required clearance'}</text>
      <text x={PAD.l + 8} y={H - PAD.b - 10} fill={FAINT} fontSize="12">a route must stay above the dashed line</text>
      {data.horizonEnd < data.t1 - 1e-9 && (
        <g>
          <rect x={x(data.horizonEnd)} y={PAD.t} width={Math.max(0, W - PAD.r - x(data.horizonEnd))} height={H - PAD.b - PAD.t} fill="rgba(160,140,220,.10)" />
          <line x1={x(data.horizonEnd)} x2={x(data.horizonEnd)} y1={PAD.t} y2={H - PAD.b} stroke={FAINT} strokeDasharray="2 4" />
          <text x={x(data.horizonEnd) + 8} y={PAD.t + 14} fill={FAINT} fontSize="12">beyond the model’s horizon: re-checked as new data arrives</text>
        </g>
      )}
      <path d={path(data.direct, x, y)} fill="none" stroke={AMBER} strokeWidth="3" opacity={fade(u, 0.4)} />
      <text x={x(data.direct[Math.floor(data.direct.length * 0.12)]!.t)} y={y(data.direct[Math.floor(data.direct.length * 0.12)]!.v) - 12} fill={AMBER} fontSize="13" opacity={fade(u, 0.8)}>{data.firstLabel ?? 'direct route'}</text>
      {showConflict && data.conflict && (
        <g opacity={fade(u, 2.2)}>
          <line x1={x(data.conflict.t)} x2={x(data.conflict.t)} y1={y(data.conflict.distance)} y2={y(data.conflict.required)} stroke="#ff9e6b" strokeWidth="3" />
          <circle cx={x(data.conflict.t)} cy={y(data.conflict.distance)} r="6.5" fill="#ffd2a0" />
          <text x={x(data.conflict.t) + 12} y={y(data.conflict.distance) + 22} fill="#ffe2bc" fontSize="14" fontWeight="600">{data.conflict.distance.toFixed(1)} u</text>
          <text x={x(data.conflict.t) + 12} y={y(data.conflict.distance) + 40} fill="#ffe2bc" fontSize="12.5">needs {data.conflict.required.toFixed(1)} u</text>
        </g>
      )}
      {showChosen && (
        <g opacity={fade(u, 1)}>
          <path d={path(data.chosen, x, y)} fill="none" stroke="#fff0ff" strokeWidth="3.4" />
          <text x={x(data.chosen[Math.floor(data.chosen.length * 0.55)]!.t)} y={y(data.chosen[Math.floor(data.chosen.length * 0.55)]!.v) - 12} fill="#fff0ff" fontSize="13">{data.secondLabel ?? 'ATLAS route'}</text>
          {data.chosenMin && <circle cx={x(data.chosenMin.t)} cy={y(data.chosenMin.distance)} r="5.5" fill="#fff0ff" />}
        </g>
      )}
    </Frame>
  );
}
