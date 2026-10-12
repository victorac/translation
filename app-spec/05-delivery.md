# 05 — Acceptance criteria and implementation plan

## Release acceptance tests

| ID | Scenario and expected result |
|---|---|
| AC-01 | Paste Japanese dialogue, Latin names, emoji and mixed newlines. Preview/reopen reproduces exact source; concatenated block slices equal original and no surrogate is split. |
| AC-02 | Run 5 blocks with 2 mock models. Exactly 10 successful requests occur in model-major/block order; never more than one active request; outputs attach to correct block/run. |
| AC-03 | Add a third model mid-run. It receives the same source snapshot and block IDs after queued models. Closing its pane leaves work/results intact; reopening restores them. |
| AC-04 | Place outputs beside and above/below, resize/reorder, close/reopen, and save/reopen. Tree and ratios restore; narrow window uses tabs; source remains accessible. |
| AC-05 | Streaming updates correct region; progress never counts draft as success. Arbitrarily fragmented UTF-8/SSE yields identical assembled output. Reasoning fields do not enter translation. |
| AC-06 | Cancel the whole job during stream/backoff and inject late success. No result commits and no next queued request dispatches; draft remains labeled incomplete. Canceling one model leaves other queued models runnable. |
| AC-07 | Fail block 2 after partial output. Draft remains, later blocks may proceed with explicit source-only context, and successful block 1 is untouched. Retry creates a new attempt and changed context marks downstream outputs stale. |
| AC-08 | Edit a successful block, then retry it. Manual version remains current until candidate acceptance. Both versions survive saving/reopening and original/current exports differ correctly. |
| AC-09 | Edit source after Run. New revision is created; active job retains old hash. New Run does not mix output/block IDs across revisions. |
| AC-10 | Kill app mid-stream, reopen recovery and Resume. Active attempt becomes interrupted; completed blocks are not regenerated; interrupted block gets a new attempt. |
| AC-11 | Simulate refused connection, auth failure, unavailable model, context overflow, timeout, 429/5xx and malformed data. Behavior matches failure table; retry limits and actionable messages hold. |
| AC-12 | Finish reason length/refusal/unknown or empty output cannot silently become Done. Review flags and raw candidates persist. |
| AC-13 | Save/reopen project with glossary/settings/layout/versions. No API token is present. Disk-full leaves previous saved file usable and halts dispatch with Save As available. |
| AC-14 | Export text, Markdown and comparison CSV with Unicode, quotes/newlines and missing blocks. Source order is preserved, CSV is RFC-4180 escaped, incomplete exports require explicit action and carry markers/status. |
| AC-15 | Remote endpoint is blocked until opt-in; cross-host redirect is rejected; source containing scripts/instructions is displayed as text and cannot execute app actions. |
| AC-16 | On 1 MiB source within 2,000-block limit with 3 panes and mock streaming, typing/navigation stays below 100 ms p95 on a documented test machine; view count never changes inference concurrency. |
| AC-17 | Entire basic workflow is keyboard-operable, statuses readable without color, and changing block selection focuses the aligned counterpart with linked-scroll feedback suppressed. |
| AC-18 | LM Studio smoke test: discover or manually select an installed chat model, translate three blocks, cancel, retry and export. Record server/model/quantization/context and memory settings; no assumed model residency. |

## Translation quality evaluation (separate from API correctness)

Maintain 10–20 consented/public-domain passages covering ambiguous dialogue, names, pronouns, honorifics, paragraph breaks, long sentences and graphic/profane fictional content. Include the reference sample containing `やっぱり、そうなんだね` to assess whether resignation/confirmation nuance survives; no single English wording is mandated. Human review scores fidelity, omissions/additions, name consistency and naturalness. Compare identical snapshots/configurations and record results; app release depends on workflow correctness, while recommended prompts/models depend on this evaluation. No universal numeric model rating is claimed.

## Initial implementation sequence

1. **Foundation and contracts.** Create desktop/UI/domain/provider packages, IPC schemas and secure shell. Implement fake provider with deterministic deltas/errors/cancellation. Deliver a pasted-source → mock-output vertical slice. Exit: AC-02, AC-05, AC-15 baseline.
2. **Snapshots and chunking.** Implement deterministic chunker, prompt budgeting, revisions/glossary/config hashes and preflight preview. Unit/property tests cover losslessness, punctuation, oversize spans and budget failure. Exit: AC-01, AC-09.
3. **Local provider and coordinator.** Implement discovery/manual IDs, HTTP/SSE parser, model-major queue, attempt transitions, wait/skip, retries and race guards. Test with fake HTTP server, then LM Studio. Exit: AC-06, AC-07, AC-11, AC-12, AC-18.
4. **Comparison workspace.** Build recursive split tree, block-aware output editors, linked scrolling, dynamic runs, status rail/tray and manual/candidate version flow. Prototype protected editor boundaries before expanding layout complexity. Exit: AC-03, AC-04, AC-08, AC-17.
5. **Durability and export.** Add schema validation/migration scaffolding, atomic saves, recovery journal, resume, export preview and format writers. Fault-inject disk failures and process termination. Exit: AC-10, AC-13, AC-14.
6. **Release hardening.** Performance benchmark, accessibility pass, installer builds for initial platforms, local setup guide and quality fixture evaluation. Exit: remaining criteria, especially AC-16; all P0 issues closed.

Order is dependency-based; tasks may overlap only after shared interfaces are stable. No delivery-date estimate is implied. Each milestone produces a runnable app and evidence for its acceptance tests.

## Suggested first backlog

- P0: immutable revision/block schema and lossless chunking fixtures.
- P0: fake provider, terminal-event contract and cancel race tests.
- P0: local adapter with fragmented SSE and timeout fixtures.
- P0: source/output editor prototype demonstrating protected boundaries and candidate acceptance.
- P0: atomic persistence and interrupted-job recovery.
- P1: recursive layout persistence, aligned scroll and keyboard controls.
- P1: export preview plus text/Markdown/CSV writers.
- P1: performance profiling and setup/recovery documentation.

## Decisions to validate during implementation

Exact model context and token counting may be unknown through generic discovery: require a user-confirmed limit, conservative estimate and clear overflow recovery. Some servers ignore abort or load models on demand: client cancellation is authoritative for app state, but server capacity remains external. Translation paragraphs need not match source paragraphs: align by block rather than forcing line correspondence. Electron is the proposed stack; switching to another shell must preserve process isolation, native file access, cancellation and persistence contracts.
