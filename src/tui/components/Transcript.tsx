import { Static } from 'ink';

import type { TranscriptItem } from '../store/state.js';
import { TranscriptItemView } from './TranscriptItem.js';

/**
 * The append-only transcript, over Ink's <Static>: items render once and
 * flow into terminal scrollback; only new items are ever painted (R2).
 * Every item must therefore be final before it is appended.
 */
export function Transcript({
  items,
  verbose = false,
}: {
  items: readonly TranscriptItem[];
  /** Render dim input/result detail under activity/evidence lines. */
  verbose?: boolean;
}) {
  return (
    <Static items={items as TranscriptItem[]}>
      {(item) => <TranscriptItemView key={item.id} item={item} verbose={verbose} />}
    </Static>
  );
}
