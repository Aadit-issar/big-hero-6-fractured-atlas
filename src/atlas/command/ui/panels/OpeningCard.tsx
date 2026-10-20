import type { CommandSession, CommandSnapshot } from '../../session';

/** The quiet card shown before the first observation arrives: what ATLAS is, and the one action that connects it. */
export function OpeningCard({ snap, session }: { snap: CommandSnapshot; session: CommandSession }) {
  const connecting = snap.link.status === 'connecting';
  return (
    <div className="opening" data-testid="cmd-opening" role="dialog" aria-label="Connect ATLAS">
      <p className="kick">ATLAS COMMAND</p>
      <h1>{connecting ? 'Waiting for the Dimension to answer' : 'Connect to the running Dimension'}</h1>
      <p>ATLAS shows only what Baymax's sensors have reported. Nothing appears on the map until it has been observed.</p>
      <ol className="steps">
        <li><span><b>Open the Dimension</b> from here, or press <kbd>L</kbd> inside a running Dimension.</span></li>
        <li><span><b>Scan</b>: objects, islands and folds appear as they are observed.</span></li>
        <li><span><b>Select</b> a target to see where it will be, then send Baymax there.</span></li>
      </ol>
      <div className="row">
        <button className="primary big" type="button" onClick={() => session.openDimension()} data-testid="open-dimension">{connecting ? 'Retry connection' : 'Open Dimension and connect'}</button>
      </div>
      <small>{snap.link.status === 'disconnected' ? 'The last attempt timed out. ' : ''}{session.dimensionUrl}</small>
    </div>
  );
}
