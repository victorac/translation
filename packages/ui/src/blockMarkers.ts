import type { BoundaryKind } from "@ltw/domain";
import { AWKWARD_BOUNDARIES, BOUNDARY_PHRASE } from "@ltw/domain/pure";

export interface PreviewBlock {
  index: number;
  text: string;
  estimatedTokens: number;
  boundaryKind: BoundaryKind;
}

/** Where a block starts in the editor text, and what to say about it. */
export interface BlockMarker {
  index: number;
  start: number;
  end: number;
  /** The block starts at the beginning of a line, so a divider can sit above it. Otherwise it starts mid-line (a cut). */
  atLineStart: boolean;
  tokens: number;
  /** How this block ends, in words, if that deserves attention. */
  warning: string | null;
  /** The block before this one ended with a rough cut, so this one begins mid-sentence. */
  cutBefore: boolean;
}

/**
 * Turns the split of a text into positions in the editor. Returns null unless the blocks are exactly this text,
 * so a split that is out of date (the text changed since) is never drawn in the wrong place.
 */
export function blockMarkers(doc: string, blocks: readonly PreviewBlock[]): BlockMarker[] | null {
  let pos = 0;
  let previousWarning: string | null = null;
  const markers: BlockMarker[] = [];
  for (const b of blocks) {
    if (!doc.startsWith(b.text, pos)) return null;
    const start = pos;
    pos += b.text.length;
    const warning = AWKWARD_BOUNDARIES.has(b.boundaryKind) ? BOUNDARY_PHRASE[b.boundaryKind] : null;
    markers.push({
      index: b.index,
      start,
      end: pos,
      atLineStart: start === 0 || doc[start - 1] === "\n",
      tokens: b.estimatedTokens,
      warning,
      cutBefore: previousWarning !== null,
    });
    previousWarning = warning;
  }
  return pos === doc.length ? markers : null;
}
