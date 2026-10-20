import type { RenderReadiness } from '../rendering/renderReadiness';

export function HelpOverlay({ readiness }: { readonly readiness: RenderReadiness }) {
  const terrain = readiness.terrainTotal ? `${readiness.terrainReady}/${readiness.terrainTotal}` : '…';
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <div className="loading-orbit" aria-hidden="true"><span /></div>
      <p>Establishing dimensional reference…</p>
      <p className="loading-detail">GEOLOGY {terrain} · MATERIALS {readiness.texturesReady ? 'READY' : '…'} · SKY {readiness.skyReady ? 'READY' : '…'} · MATTER {readiness.gasReady ? 'READY' : '…'}</p>
    </div>
  );
}
