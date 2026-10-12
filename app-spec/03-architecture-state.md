# 03 — Architecture and state

## Component boundaries

```text
React workspace + CodeMirror editors
             │ typed, validated IPC / versioned events
Electron main process
 ├─ Project repository (atomic JSON, recovery journal)
 ├─ Translation coordinator (queue, budgets, attempts)
 ├─ Chunker + prompt builder + validators
 ├─ Provider registry → OpenAI-compatible adapter → local server
 └─ Credential store + export service
```

Renderer has no Node access; context isolation and sandbox enabled. Preload exposes only allowlisted commands. Main process validates payloads, paths, endpoint policy and sizes. Render source/output as plain text; no execution, embedded HTML or tool calls from model text. Model server is external to app lifetime.

Use a monorepo with `desktop`, `ui`, `domain`, `providers`, and `test-fixtures` packages. Keep domain functions pure and testable. No database required for MVP; keep a compact current project plus append-only local attempt/event journal, periodically compacted after a successful checkpoint. Never persist every streamed token.

## Persisted entities

All IDs are UUID strings; times UTC ISO-8601; offsets are JavaScript UTF-16 code units, with boundaries never inside surrogate pairs. `schemaVersion` begins at 1.

| Entity | Required fields |
|---|---|
| Project | id, schemaVersion, title, createdAt, updatedAt, activeRevisionId, revisions, providerRefs, layout |
| SourceRevision | id, parentId?, exactText, sha256, sourceLanguage, targetLanguage, chunkerVersion, chunkSettings, blocks |
| Block | id, revisionId, index, startOffset, endOffset, textHash, boundaryKind, estimatedTokens |
| ProviderRef | id, adapterKind, label, baseUrl, credentialRef?; no secret |
| ModelRun | id, revisionId, providerRefId, modelId, configSnapshot, promptVersion, glossarySnapshot, state, archived, outputs |
| BlockOutput | blockId, state, attempts, currentVersionId?, staleReason?, contextDependencyAttemptIds |
| Attempt | id, ordinal, configHash, sourceHash, contextHash, state, draft?, rawOutput?, finishReason?, startedAt?, endedAt?, usage?, error? |
| OutputVersion | id, blockId, attemptId?, kind: generated/manual, text, createdAt, baseVersionId? |
| Job | id, revisionId, orderedRunIds, state, activeAttemptId?, queue cursor, createdAt |
| LayoutNode | leaf: paneId + source revision/run reference; split: axis `row` (beside) or `column` (stacked), children[2], ratio 0..1 |

Keep attempts and versions nested under their owning output for portable JSON; IDs still reference them. Provider settings resolve by ID; if unavailable on another machine, mark disconnected and ask for mapping. Shared API credentials resolve only on the original machine.

## State transitions

Attempt: `pending → waiting → running → succeeded | needs_review | failed | canceled`. Automatic retries create new attempts, never reuse IDs. On recovery, prior `running/waiting` attempts become `interrupted`; explicit Resume creates new attempts for interrupted/pending/canceled work.

Block output: `pending | waiting | running | succeeded | needs_review | failed | canceled | stale`. Aggregate from latest attempt and current accepted version; a failed retry may coexist with usable prior text. UI shows “Retry failed; prior result retained.” Draft text is never an accepted version.

Job/run: `queued → running ↔ waiting → completed | completed_with_issues | canceled | interrupted`. All blocks terminal yields completed if all succeeded, otherwise completed_with_issues; user cancellation yields canceled even if some blocks succeeded. Re-entering work creates a new job. A waiting model blocks subsequent dispatch until fixed, skipped, or canceled.

## Invariants and race rules

1. Block slices, ordered by index, concatenate to the exact source snapshot. No missing or duplicated characters.
2. A model run belongs to one source revision. Job configs are frozen; changes create a new run revision.
3. At most one active attempt globally in MVP. Dispatch next only after current is terminal and checkpointed.
4. A result commits only if job/run/block/attempt IDs and generation epoch match, and attempt is still running. Late events after cancel are ignored.
5. Manual/current accepted versions cannot be overwritten by streaming or retry completion.
6. Pane IDs and run IDs differ; closing views never deletes output.
7. Source hash, prompt/config hash, glossary and context dependencies travel with every attempt.
8. Accepting a changed upstream translation invalidates downstream context-dependent results for that model. Keep stale output readable/exportable with status.

## IPC contract

Commands return `{requestId, ok, value? , error?}`. Commands: `provider.test/listModels`, `project.open/save`, `revision.create/activate`, `job.start/cancel/resume`, `run.add/archive`, `block.retry/acceptCandidate/edit`, `layout.update`, `export.preview/write`. Each mutation includes `projectId` and `expectedProjectVersion`; reject conflicts and refresh. `job.start` takes revisionId and runIds, not arbitrary renderer-built prompts.

Events: `{eventVersion:1, projectId, jobId?, runId?, blockId?, attemptId?, seq, type, payload}`. Types include queued, waiting, started, delta, terminal, checkpointed and stateChanged. Sequence increases per job; renderer ignores duplicates, requests a snapshot on gaps, and never reconstructs persisted truth solely from deltas.

## Persistence and recovery

Autosave accepted mutations after 500 ms debounce; stream draft checkpoint every 2 seconds at most. Save writes same-directory temporary file, flushes, then atomic rename, preserving last known-good backup. Surface disk-full/permission errors and stop dispatch if terminal checkpoints cannot persist; retain memory and offer Save As. Validate file shape, hashes, sizes, offsets and schema before loading. Do not silently repair corrupted projects; offer backup recovery. Newer unknown schemas open read-only for safe export when possible; otherwise fail clearly. Migrations produce a backup first.
