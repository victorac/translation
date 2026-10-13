import type { RunView, WorkspaceSnapshot } from "@ltw/domain";
import { Cell } from "./Cell";
import { countCells } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];
export type SourceMode = "blocks" | "text";

/**
 * The source beside every model's translation, block by block. One scroll area, so everything stays lined up.
 * The source column is either the aligned blocks or one editable text.
 */
export function Grid({
  snap,
  text,
  onText,
  mode,
  onMode,
  runs,
  send,
  edited,
  readOnlyOld,
  title,
}: {
  snap: WorkspaceSnapshot;
  text: string;
  onText: (t: string) => void;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
  /** The model columns to show. */
  runs: RunView[];
  send: Send;
  /** The editor text differs from the newest version, so the results shown are from an earlier text. */
  edited: boolean;
  readOnlyOld: boolean;
  /** The open document's name. */
  title: string;
}) {
  const blocks = snap.revision?.blocks ?? [];
  const hasBlocks = blocks.length > 0;
  const columns = hasBlocks ? runs : [];
  const template = `minmax(16rem, 1.1fr) ${columns.map(() => "minmax(15rem, 1fr)").join(" ")}`.trim();
  const rows = Math.max(blocks.length, 1);

  const cancel = (runId: string, blockId: string) => void send("job.cancel", { kind: "block", runId, blockId });

  return (
    <div className="grid-scroll">
      <div className={edited ? "grid dimmed" : "grid"} style={{ gridTemplateColumns: template, gridTemplateRows: `auto repeat(${rows}, auto) minmax(0, 1fr)` }}>
        <div className="gh source-head" style={{ gridRow: 1, gridColumn: 1 }}>
          <span className="gh-title" title={title}>{title}</span>
          {hasBlocks && <span className="hint">{blocks.length} blocks</span>}
          {edited && <span className="tag warn-tag">edited</span>}
          {hasBlocks && (
            <div className="segmented small" role="radiogroup" aria-label="Source view">
              <button role="radio" aria-checked={mode === "blocks"} className={mode === "blocks" ? "on" : ""} onClick={() => onMode("blocks")} title="Blocks lined up with the translations">
                Blocks
              </button>
              <button role="radio" aria-checked={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => onMode("text")} title="Edit the text">
                Edit
              </button>
            </div>
          )}
        </div>
        {columns.map((run, j) => {
          const c = countCells(snap, run.id);
          return (
            <div className="gh" key={run.id} style={{ gridRow: 1, gridColumn: j + 2 }}>
              <span className="gh-title" title={run.label}>
                {run.label}
              </span>
              <span className="hint">
                {c.done}/{c.total}
                {c.failed > 0 && ` · ${c.failed} failed`}
              </span>
            </div>
          );
        })}

        {(mode === "text" || !hasBlocks) && !readOnlyOld ? (
          <textarea
            className="source-editor"
            style={{ gridRow: `2 / span ${rows + 1}`, gridColumn: 1 }}
            aria-label="Source text"
            placeholder="Paste or type the text here, add a model, then press Run."
            value={text}
            onChange={(e) => onText(e.target.value)}
            spellCheck={false}
          />
        ) : null}

        {hasBlocks &&
          blocks.map((block, i) => (
            <div className="row-fragment" key={block.id} style={{ display: "contents" }}>
              {mode === "blocks" || readOnlyOld ? (
                <div className="cell source-cell" id={`block-${block.index + 1}`} style={{ gridRow: i + 2, gridColumn: 1 }}>
                  <span className="block-no" aria-hidden="true">
                    {block.index + 1}
                  </span>
                  <span className="sr-only">Block {block.index + 1}. </span>
                  <p className="text">{block.text}</p>
                </div>
              ) : (
                <span id={`block-${block.index + 1}`} style={{ gridRow: i + 2, gridColumn: 1, display: "none" }} />
              )}
              {columns.map((run, j) => (
                <div className="cell-slot" key={run.id} style={{ gridRow: i + 2, gridColumn: j + 2 }}>
                  <Cell
                    cell={run.blocks[block.id]!}
                    label={run.label}
                    n={block.index + 1}
                    actions={{
                      retry: () => void send("block.retry", { runId: run.id, blockId: block.id }),
                      cancel: () => cancel(run.id, block.id),
                      edit: (t) => void send("block.edit", { runId: run.id, blockId: block.id, text: t }),
                      acceptCandidate: () => void send("block.acceptCandidate", { runId: run.id, blockId: block.id }),
                      keepCurrent: () => void send("block.keepCurrent", { runId: run.id, blockId: block.id }),
                      acceptReview: () => void send("block.acceptReview", { runId: run.id, blockId: block.id }),
                    }}
                  />
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}
