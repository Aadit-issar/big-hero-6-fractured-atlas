import { useMemo, useState } from 'react';
import type { CommandSnapshot } from '../../session';
import { categorise, featuredTargets, searchTargets } from '../../targets';
import type { CatalogueItem, NavTarget, RankContext } from '../../targets';
import { dist, f0 } from './logic';

const CLASS_TAG: Record<NavTarget['targetClass'], string> = { 'moving-object': 'MOVING', 'static-object': 'OBJECT', island: 'ISLAND', fold: 'FOLD' };

function Row({ t, sel, onSelect, bay, hint }: { t: NavTarget; sel: boolean; onSelect: (id: string) => void; bay: readonly number[] | null; hint?: string }) {
  return (
    <button type="button" className={`trow ${sel ? 'sel' : ''} ${t.knowledge}`} onClick={() => onSelect(t.id)} data-testid={`target-${t.id}`} aria-pressed={sel}>
      <span className={`tag ${t.targetClass}`}>{CLASS_TAG[t.targetClass]}</span>
      <span className="tname">{t.label}</span>
      <span className="tmeta">{[hint, t.knowledge === 'current' ? (hint ? null : 'live') : `last known ${f0(t.age)} s ago`, bay ? `${f0(dist(t.position, bay))} m` : null].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

/** Quick-target catalogue: featured targets first, then collapsed categories with counts. It is not the database: rubble lives under "All scanned objects", aggregated. */
export function Catalogue({ snap, onSelect, onCollapse }: { snap: CommandSnapshot; onSelect: (id: string) => void; onCollapse: () => void }) {
  const [query, setQuery] = useState('');
  const [liveOnly, setLiveOnly] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const bay = snap.pose?.position ?? null;
  const ctx: RankContext = useMemo(() => ({ baymax: (bay as RankContext['baymax']) ?? null, selectedId: snap.selectedId, recentIds: snap.recentIds, routeTargetId: snap.route.active?.targetId ?? null }), [bay, snap.selectedId, snap.recentIds, snap.route.active]);
  const featured = useMemo(() => featuredTargets(snap.targets, ctx), [snap.targets, ctx]);
  const categories = useMemo(() => categorise(snap.targets, ctx, { liveOnly }), [snap.targets, ctx, liveOnly]);
  const results = useMemo(() => searchTargets(snap.targets, query, ctx), [snap.targets, query, ctx]);
  const searching = query.trim().length > 0;
  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const renderItem = (item: CatalogueItem) => {
    if (item.kind === 'single') return <Row key={item.target.id} t={item.target} sel={snap.selectedId === item.target.id} onSelect={onSelect} bay={bay} />;
    const isOpen = open.has(item.key) || item.containsSelected;
    const members = [...item.members].sort((a, b) => (bay ? dist(a.position, bay) - dist(b.position, bay) : 0));
    return (
      <div key={item.key} className="tgroup">
        <button type="button" className="tgroup-head" onClick={() => toggle(item.key)} aria-expanded={isOpen} data-testid={`group-${item.key}`}>
          <span className="tag group">GROUP</span><span className="tname">{item.label}</span><span className="tmeta">{isOpen ? 'hide' : 'show nearest'}</span>
        </button>
        {isOpen && members.slice(0, 12).map(m => <Row key={m.id} t={m} sel={snap.selectedId === m.id} onSelect={onSelect} bay={bay} />)}
        {isOpen && members.length > 12 && <p className="tmore">{members.length - 12} more: use search</p>}
      </div>
    );
  };

  return (
    <div className="cat" data-testid="catalogue">
      <header className="cat-head">
        <h2>Targets</h2>
        <span className="count">{snap.targets.length} known</span>
        <button type="button" className="ghost icon" onClick={onCollapse} aria-label="Collapse target list" title="Collapse">{'‹'}</button>
      </header>
      <div className="cat-tools">
        <input className="search" placeholder="Search targets" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search targets" data-testid="search" />
        <button type="button" className={`chip ${liveOnly ? 'on' : ''}`} onClick={() => setLiveOnly(v => !v)} aria-pressed={liveOnly} title="Hide remembered targets that are not observed now">Live</button>
      </div>
      <div className="cat-body">
        {snap.targets.length === 0 && <p className="empty">Nothing observed yet. Press Scan.</p>}
        {searching ? (
          <section>
            <h3>Results <span>{results.length}</span></h3>
            {results.length === 0 && <p className="empty">No target matches.</p>}
            {results.map(t => <Row key={t.id} t={t} sel={snap.selectedId === t.id} onSelect={onSelect} bay={bay} />)}
          </section>
        ) : (
          <>
            {featured.length > 0 && (
              <section data-testid="featured">
                <h3>Quick targets</h3>
                {featured.map(f => <Row key={f.target.id} t={f.target} sel={snap.selectedId === f.target.id} onSelect={onSelect} bay={bay} hint={f.reason} />)}
              </section>
            )}
            {categories.length > 0 && <h3 className="cats-title">Browse</h3>}
            {categories.map(c => {
              const isOpen = open.has(`cat:${c.id}`);
              return (
                <section key={c.id} className={`category ${isOpen ? 'open' : ''}`}>
                  <button type="button" className="cat-toggle" onClick={() => toggle(`cat:${c.id}`)} aria-expanded={isOpen} data-testid={`category-${c.id}`}>
                    <span className="chev">{isOpen ? '▾' : '▸'}</span><span>{c.label}</span><b>{c.count}</b>
                  </button>
                  {isOpen && <div className="cat-items">{c.items.map(renderItem)}</div>}
                </section>
              );
            })}
          </>
        )}
      </div>
      <footer className="legend" aria-label="Legend">
        <span><i className="sw current" />Observed now</span><span><i className="sw remembered" />Last known</span><span><i className="sw predicted" />Predicted</span>
      </footer>
    </div>
  );
}
