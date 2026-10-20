import { useEffect, useState } from 'react';

const STORAGE_KEY = 'fractured.pairNotice.dismissed';
const DIMENSION_REPO = 'https://github.com/Aadit-issar/big-hero-6-fractured-dimension';
const ATLAS_REPO = 'https://github.com/Aadit-issar/big-hero-6-fractured-atlas';

function initiallyVisible(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('pairNotice') === '0') return false;
    return window.localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

/**
 * Start-up reminder that the Dimension and ATLAS Command are a pair. Non-modal: the wrapper ignores pointer events, the card takes none of the
 * keyboard (no autofocus, no key handlers), and `?pairNotice=0` or "Don't show again" removes it. `which` is the app showing it.
 */
export function PairNotice({ which, hidden = false }: { which: 'dimension' | 'atlas'; hidden?: boolean }) {
  const [open, setOpen] = useState(initiallyVisible);
  useEffect(() => { if (hidden) setOpen(false); }, [hidden]);
  if (!open) return null;
  const other = which === 'dimension' ? 'ATLAS Command' : 'the Fractured Dimension';
  const dismiss = (forever: boolean) => {
    setOpen(false);
    if (forever) { try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch { /* storage unavailable */ } }
  };
  const btn = { font: 'inherit', fontSize: 12, padding: '7px 12px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgb(150 175 210 / 35%)', background: 'rgb(90 110 150 / 25%)', color: '#e3ebf7' } as const;
  return (
    <div role="region" aria-label="Install both applications" data-testid="pair-notice"
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'end start', padding: which === 'dimension' ? '0 0 72px 24px' : '0 0 24px 24px', boxSizing: 'border-box', pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto', maxWidth: 400, margin: 0, padding: '18px 20px', borderRadius: 8, border: '1px solid rgb(150 175 210 / 30%)', background: 'rgb(14 20 36 / 92%)', color: '#c9d4e6', fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, boxShadow: '0 12px 40px rgb(0 0 0 / 50%)' }}>
        <div style={{ fontSize: 11, letterSpacing: '.12em', color: '#8fa6c8', marginBottom: 6 }}>BIG HERO 6: FRACTURED</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Install both applications</div>
        <div>The Fractured Dimension and ATLAS Command are designed to run together. For the live connection, install <b>both</b> from GitHub and start them side by side; {which === 'dimension' ? 'this app on its own cannot connect to' : 'this app on its own has nothing to connect to without'} {other}.</div>
        <ul style={{ margin: '10px 0 12px', paddingLeft: 18 }}>
          <li><a style={{ color: '#9cc4ff' }} href={DIMENSION_REPO} target="_blank" rel="noopener noreferrer">Fractured Dimension</a></li>
          <li><a style={{ color: '#9cc4ff' }} href={ATLAS_REPO} target="_blank" rel="noopener noreferrer">ATLAS Command</a></li>
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} onClick={() => dismiss(true)}>Don't show again</button>
          <button type="button" style={btn} onClick={() => dismiss(false)}>Got it</button>
        </div>
      </div>
    </div>
  );
}
