import { useState } from 'react';
import type { CommandSession, CommandSnapshot } from '../../session';

/** The latest intelligence event as one quiet line, with the full log one click away. It replaces the always-open Activity list. */
export function EventToast({ snap, session }: { snap: CommandSnapshot; session: CommandSession }) {
  const [open, setOpen] = useState(false);
  const latest = snap.log.at(-1);
  if (!latest) return null;
  const age = Math.max(0, (session.wall() - latest.atWall) / 1000);
  const items = snap.log.slice(-14).reverse();
  return (
    <div className={`toast ${open ? 'open' : ''}`} data-testid="activity">
      {open && (
        <ul className="toast-log" data-testid="activity-log">
          {items.map(l => <li key={l.id} className={l.tone}><b>{l.title}</b><span>{l.detail}</span></li>)}
        </ul>
      )}
      <button type="button" className={`toast-line ${latest.tone} ${age < 6 ? 'fresh' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} title="Show the event log">
        <i />
        <b>{latest.title}</b>
        <span>{latest.detail}</span>
        <em>{open ? 'Hide log' : 'Log'}</em>
      </button>
    </div>
  );
}
