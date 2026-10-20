import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const SESSION_KEY = 'fractured.pairNoticeAcknowledged';
const DIMENSION_REPO = 'https://github.com/Aadit-issar/big-hero-6-fractured-dimension';
const ATLAS_REPO = 'https://github.com/Aadit-issar/big-hero-6-fractured-atlas';

function alreadyAcknowledged(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('pairNotice') === '0') return true;
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Start-up gate: the application is not mounted (and therefore does not load or run) until the visitor presses OK on a notice saying the
 * Dimension and ATLAS Command are meant to be installed together from GitHub. Acknowledgement is remembered for this tab only, so a reload
 * does not ask again; `?pairNotice=0` skips the gate (automated tests). `which` is the application showing it.
 */
export function PairGate({ which, children }: { which: 'dimension' | 'atlas'; children: ReactNode }) {
  const [ok, setOk] = useState(alreadyAcknowledged);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!ok) button.current?.focus(); }, [ok]);
  if (ok) return <>{children}</>;
  const here = which === 'dimension' ? 'the Fractured Dimension' : 'ATLAS Command';
  const other = which === 'dimension' ? 'ATLAS Command' : 'the Fractured Dimension';
  const accept = () => {
    try { window.sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* storage unavailable */ }
    setOk(true);
  };
  const link = { color: '#9cc4ff', fontWeight: 600 } as const;
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="pair-title" data-testid="pair-notice"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 16, boxSizing: 'border-box', background: 'radial-gradient(ellipse at 50% 45%, #2a1650, #07060f 80%)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 560, width: '100%', boxSizing: 'border-box', padding: '34px 36px 30px', borderRadius: 14, border: '1px solid rgb(190 150 255 / 45%)', background: 'rgb(16 12 34 / 96%)', color: '#d3d9ea', fontSize: 16, lineHeight: 1.55, boxShadow: '0 0 60px rgb(150 90 255 / 28%), 0 20px 60px rgb(0 0 0 / 60%)' }}>
        <div style={{ fontSize: 12, letterSpacing: '.18em', color: '#b79cff', marginBottom: 10 }}>BIG HERO 6: FRACTURED</div>
        <h1 id="pair-title" style={{ margin: '0 0 14px', fontSize: 28, lineHeight: 1.2, color: '#fff' }}>Install both applications</h1>
        <p style={{ margin: '0 0 12px' }}>
          The <b>Fractured Dimension</b> and <b>ATLAS Command</b> are two halves of one system. For the live connection to work, install <b>both</b> from GitHub and run them side by side.
        </p>
        <p style={{ margin: '0 0 16px' }}>
          You are running {here}. On its own it cannot {which === 'dimension' ? 'receive routes from' : 'observe anything without'} {other}.
        </p>
        <ul style={{ margin: '0 0 24px', paddingLeft: 20 }}>
          <li><a style={link} href={DIMENSION_REPO} target="_blank" rel="noopener noreferrer">Fractured Dimension on GitHub</a></li>
          <li><a style={link} href={ATLAS_REPO} target="_blank" rel="noopener noreferrer">ATLAS Command on GitHub</a></li>
        </ul>
        <div style={{ textAlign: 'right' }}>
          <button ref={button} type="button" onClick={accept}
            style={{ font: 'inherit', fontSize: 16, fontWeight: 700, padding: '11px 38px', borderRadius: 8, cursor: 'pointer', border: '1px solid #c9a8ff', background: 'linear-gradient(#8a55e8, #6a35c8)', color: '#fff' }}>OK</button>
        </div>
      </div>
    </div>
  );
}
