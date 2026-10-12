# Local Translation Workbench — specification package

Version 0.1 • 2026-10-11 • Ready for implementation planning

A local desktop workspace for translating long-form text with local language models and comparing editable results. Japanese → English fiction is the initial use case; language pairs remain configurable.

## Read in order

1. [Product requirements and scope](01-product.md)
2. [UX and editor behavior](02-ux.md)
3. [Architecture and persisted state](03-architecture-state.md)
4. [Translation pipeline and provider contracts](04-pipeline-providers.md)
5. [Acceptance criteria and implementation plan](05-delivery.md)

## Binding decisions

- Suggested implementation: Electron + TypeScript + React + CodeMirror 6, with privileged work in the main process. These are design choices, not installed dependencies or version commitments.
- Desktop app; LM Studio runs separately. No bundled model, cloud fallback, account, telemetry, or automatic model download.
- One inference request globally by default. Finish one model's blocks before the next model to reduce model switching on small GPUs.
- Shared immutable source blocks across all model runs; output alignment is by block identity, not line number.
- Streaming drafts, generated versions, and user edits are distinct. Retry never silently replaces edits.
- Native project format is versioned JSON; exports are UTF-8 text, Markdown, and comparison CSV.
- Pane layout is a recursive split tree: side-by-side and stacked splits are both first-class.

## External integration references

Verified 2026-10-11: LM Studio documents `GET /v1/models` and `POST /v1/chat/completions`, a configurable local base URL, and streaming/inference parameters. The app targets this subset and tests capability differences rather than assuming full compatibility. [LM Studio compatibility documentation](https://lmstudio.ai/docs/developer/openai-compat), [Chat Completions documentation](https://lmstudio.ai/docs/developer/openai-compat/chat-completions).

## Definition of ready

The documents define the MVP behavior, contracts, invariants, edge cases, and release tests. Before selecting dependency versions, validate the editor block-decoration prototype and the chosen LM Studio model's context/streaming behavior. Translation quality requires evaluation with representative source passages; an API success is not evidence of faithful translation.
