import type { KnowledgeSnapshot } from '../live/knowledge';
import type { LinkState } from '../live/linkCore';

const fmt = (p: readonly number[]) => p.map(n => n.toFixed(1)).join(', ');

/** Advanced Analysis section for scene-object scans: exact records, cluster composition, scan history and (for a linked
 * session) the live-link diagnostics. It shows values rather than prose so claims can be verified. */
export function SceneObjectsAnalysis({ knowledge, link }: { readonly knowledge: KnowledgeSnapshot; readonly link?: LinkState }) {
  const { records, clusters, scans } = knowledge.scene;
  return (
    <section className="scene-analysis" aria-label="Scene-object scans" data-testid="scene-analysis">
      <h2>Scene-object scans</h2>
      <p className="scene-analysis-note">Category B observations from the proximity scanner. They are separate from the Phase 1–3 sensor contract and are recorded only when a scan reports them.</p>
      {link && (
        <dl className="scene-analysis-link" data-testid="link-diagnostics">
          <div><dt>Link status</dt><dd>{link.status}</dd></div>
          <div><dt>Dimension session</dt><dd>{link.session ?? 'none'}</dd></div>
          <div><dt>Episode</dt><dd>{link.episode}</dd></div>
          <div><dt>Origin</dt><dd>{link.dimensionOrigin ?? 'unpinned'}</dd></div>
          <div><dt>Last sequence</dt><dd>{link.lastSeq}</dd></div>
          <div><dt>Last simulation time</dt><dd>{link.lastSimTime === null ? '—' : link.lastSimTime.toFixed(2)}</dd></div>
          <div><dt>Frames accepted</dt><dd>{link.counters.accepted}</dd></div>
          <div><dt>Rejected (duplicate / session / malformed / origin)</dt><dd>{link.counters.duplicate} / {link.counters.foreignSession} / {link.counters.malformed} / {link.counters.badOrigin}</dd></div>
        </dl>
      )}
      <h3>Clusters ({clusters.length})</h3>
      <table><thead><tr><th>Cluster</th><th>Objects</th><th>Observed</th><th>Remembered</th><th>Centre</th><th>Extent</th><th>Composition</th></tr></thead>
        <tbody>{clusters.map(c => <tr key={c.id}><td>{c.label}</td><td>{c.count}</td><td>{c.currentlyObserved}</td><td>{c.remembered}</td><td>{fmt(c.centre)}</td><td>{c.extent.toFixed(1)}</td><td>{Object.entries(c.composition).map(([k, v]) => `${v} ${k}`).join(', ')}</td></tr>)}</tbody></table>
      <h3>Recent scans ({scans.length})</h3>
      <table><thead><tr><th>Scan</th><th>Sim t</th><th>Trigger</th><th>In range</th><th>Acquired</th><th>Refreshed</th><th>Left</th><th>Observer</th></tr></thead>
        <tbody>{scans.slice(-12).reverse().map(s => <tr key={s.scanId}><td>#{s.scanId}</td><td>{s.time.toFixed(2)}</td><td>{s.trigger}</td><td>{s.inRange}{s.omitted ? ` (+${s.omitted} omitted)` : ''}</td><td>{s.acquired}</td><td>{s.refreshed}</td><td>{s.left}</td><td>{fmt(s.observerPosition)}</td></tr>)}</tbody></table>
      <h3>Records ({records.length})</h3>
      <table><thead><tr><th>Id</th><th>Kind</th><th>Category</th><th>Status</th><th>First</th><th>Last</th><th>Obs.</th><th>Last-known position</th></tr></thead>
        <tbody>{records.slice(0, 200).map(r => <tr key={r.id}><td>{r.id}</td><td>{r.kind}</td><td>{r.category}</td><td>{r.currentlyObserved ? 'observed' : 'remembered'}</td><td>{r.firstSeenAt.toFixed(2)}</td><td>{r.lastSeenAt.toFixed(2)}</td><td>{r.observationCount}</td><td>{fmt(r.lastKnownPosition)}</td></tr>)}</tbody></table>
    </section>
  );
}
