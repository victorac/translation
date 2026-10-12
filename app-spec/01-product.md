# 01 — Product requirements

## Goal and workflow

Paste source → select languages and models → preview blocks → Run → inspect progress and compare translations → edit results → save or export.

Success means a user can complete and recover a multi-model translation without losing source, block correspondence, generated output, or editorial changes. Translation quality is assisted through prompts, glossary, context, and comparison; correctness is not guaranteed by the app.

## MVP requirements

| ID | Requirement |
|---|---|
| PR-01 | Source editor accepts Unicode paste, undo/redo, search, and plain-text import. Default languages Japanese and English; explicitly selected language pair is saved. |
| PR-02 | Configure one or more local providers; test connection, discover models, and manually enter exact model identifiers when discovery is unavailable. |
| PR-03 | Configure model runs independently: provider/model, temperature, output cap, context limit, prompt preset, and optional name/term glossary. |
| PR-04 | Preview deterministic blocks and their estimated budgets before running. All models compare the same blocks. |
| PR-05 | Translate blocks sequentially for each selected model, stream into the corresponding output region, and retain prior successful blocks. |
| PR-06 | Dynamically add, hide/remove, reopen, reorder, resize, or split output panes beside or above/below another pane. |
| PR-07 | Show overall, model, and block status; elapsed time, completed/total counts, active block, and actionable errors. |
| PR-08 | Cancel a block, model, or whole job; retry an individual block or failed/canceled blocks; resume saved unfinished work. |
| PR-09 | Edit successful output by block; preserve generated versions and protect manual edits during retries. |
| PR-10 | Save/open portable projects, autosave recovery, and export one model or a block-aligned comparison. |
| PR-11 | Persist layout and settings locally; process source only through explicitly configured endpoints. |

## Local-first boundaries

Loopback endpoints are allowed by default, including localhost, 127.0.0.1 and ::1. LAN/remote endpoints require an explicit opt-in showing the host and that text leaves the machine. No silent redirects to another host or cloud fallback. Restrict endpoint schemes to HTTP/HTTPS; reject embedded credentials. Store optional API tokens in the OS credential store, never in project/export files. Disable telemetry and external content loading. Logs contain identifiers, status, and timings; source/prompt/output logging is an explicit debug option.

## Scope

**MVP:** plain-text documents; configurable language pair; OpenAI-compatible local adapter; multiple queued model runs; streaming; split editors; glossary; recovery; retries/cancellation; manual output editing; JSON save and text/Markdown/CSV export. LM Studio model loading is managed by the user, with clear waiting instructions when needed. Initial QA on Windows and macOS; Linux packaging can follow.

**Future:** native LM Studio load/unload integration; provider-specific tokenizers and Ollama adapter; PDF/DOCX/EPUB import/export; sentence-level alignment; diff/scoring; translation memory; rolling summaries; automatic glossary extraction; model-assisted revision; batch projects; optional concurrency for separate devices; plugin SDK; packaged Linux builds.

**Out of scope:** training models, automatic censorship bypass, unattended model downloading, collaborative cloud editing, guaranteed literary fidelity, rich-text round-tripping.

## Defaults and limits

- Target block estimate: 600 tokens; soft maximum 900, constrained by the smallest selected model budget.
- Output reserve: 1,536 tokens; context window default 4,096 until user/provider confirms another value.
- Temperature 0.2; one request at a time; maximum eight configured model runs per source revision. Multiple panes may reference the same run.
- MVP document guardrail: 1 MiB UTF-8 source or 2,000 blocks, whichever is reached first. Reject excess before scheduling; retain pasted editor content for copying/saving.
- Settings changes apply to new run revisions; active requests use their captured configuration.

These are conservative starting values, configurable where specified, not guarantees that a given model fits an 8 GB GPU.
