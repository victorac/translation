# 06 — Amendments to v0.1

Decided 2026-10-12. These override the referenced text in documents 01–05.

## A1 — Line endings are normalized on import (overrides AC-01 wording, 03 "Persisted entities")

- All source text is normalized to `\n` (`\r\n` and lone `\r` → `\n`) once, at the import/paste boundary in the main process, before hashing, chunking or storing.
- The original line-ending style is **not** recorded and **not** restored on export. Exports use `\n`.
- `SourceRevision.exactText`, block offsets, and `sha256` all describe the normalized text, which is what the editor shows.
- AC-01 is read as: "exact after line-ending normalization". Tests assert normalization is idempotent and that block slices concatenate to `exactText`. Surrogate pairs, emoji and other Unicode are untouched.

## A2 — Staleness follows context hashes (overrides 02 "Progress and controls", 03 invariant 8)

- Changing the accepted text of block N does **not** blanket-mark later blocks stale.
- Instead, recompute the context that block N+1 would receive (preceding source tail + same-model preceding translation tail). If its hash differs from the `contextHash` stored on N+1's current attempt, mark N+1 stale (`staleReason: context_changed`). Otherwise leave it unchanged.
- Staleness cascades only through real changes: if N+1 is later retranslated and its accepted text changes, repeat the check for N+2.
- "Retranslate downstream" queues only blocks currently marked stale, in source order.
- The context builder must be a pure, deterministic function of (source blocks, accepted versions, config) so the comparison is reliable.

## A3 — Project version counter (fixes gap in 03)

`Project` gains `version: number`, incremented on every accepted mutation. It is the value checked by `expectedProjectVersion`.

## A4 — Package layout

pnpm workspace with four packages: `domain` (includes test fixtures), `providers`, `desktop`, `ui`. This replaces the five-package layout in 03; `test-fixtures` lives in `packages/domain/fixtures`.
