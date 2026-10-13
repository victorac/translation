import { useRef, useState } from "react";
import type { RunView, WorkspaceSnapshot } from "@ltw/domain";
import type { PreviewBlock } from "./blockMarkers";
import { Cell } from "./Cell";
import { ResizeHandle } from "./ColumnHandles";
import { SOURCE_KEY, columnTemplate, moveBefore, nudge, orderBy, type ColumnLayout } from "./layout";
import { SourceEditor } from "./SourceEditor";
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
  previewBlocks,
  editorKey,
  layout,
  onLayout,
  onHide,
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
  /** How the text in the editor would be split right now. */
  previewBlocks: readonly PreviewBlock[] | null;
  /** Changes when the editor should start fresh (another document or project), which also resets its undo history. */
  editorKey: string;
  layout: ColumnLayout;
  onLayout: (l: ColumnLayout) => void;
  /** Close a model's column (it can be shown again from the side panel). */
  onHide: (label: string) => void;
}) {
  const blocks = snap.revision?.blocks ?? [];
  const hasBlocks = blocks.length > 0;
  const columns = hasBlocks ? orderBy(runs, layout.order) : [];
  const labels = columns.map((r) => r.label);
  const template = columnTemplate(layout, labels);
  const headRefs = useRef<Record<string, HTMLElement | null>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const setWidth = (key: string, px: number) => onLayout({ ...layout, widths: { ...layout.widths, [key]: px } });
  const clearWidth = (key: string) => {
    const { [key]: _gone, ...widths } = layout.widths;
    onLayout({ ...layout, widths });
  };
  const measure = (key: string) => () => headRefs.current[key]?.getBoundingClientRect().width ?? 320;
  const arrange = (order: string[]) => onLayout({ ...layout, order });
  const rows = Math.max(blocks.length, 1);

  const cancel = (runId: string, blockId: string) => void send("job.cancel", { kind: "block", runId, blockId });

  return (
    <div className="grid-scroll">
      <div className={edited ? "grid dimmed" : "grid"} style={{ gridTemplateColumns: template, gridTemplateRows: `auto repeat(${rows}, auto) minmax(0, 1fr)` }}>
        <div className="gh source-head" ref={(el) => void (headRefs.current[SOURCE_KEY] = el)} style={{ gridRow: 1, gridColumn: 1 }}>
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
          <ResizeHandle label="source" measure={measure(SOURCE_KEY)} onResize={(px) => setWidth(SOURCE_KEY, px)} onReset={() => clearWidth(SOURCE_KEY)} />
        </div>
        {columns.map((run, j) => {
          const c = countCells(snap, run.id);
          return (
            <div
              className={`gh model-head${dragging === run.label ? " dragging" : ""}${over === run.label && dragging !== run.label ? " drop-target" : ""}`}
              key={run.id}
              ref={(el) => void (headRefs.current[run.label] = el)}
              style={{ gridRow: 1, gridColumn: j + 2 }}
              draggable
              tabIndex={0}
              aria-label={`${run.label}. Drag, or press Alt with the arrow keys, to move this column.`}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", run.label);
                setDragging(run.label);
              }}
              onDragOver={(e) => {
                if (dragging) {
                  e.preventDefault();
                  setOver(run.label);
                }
              }}
              onDragLeave={() => setOver((o) => (o === run.label ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) arrange(moveBefore(labels, dragging, run.label));
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                  e.preventDefault();
                  arrange(nudge(labels, run.label, e.key === "ArrowLeft" ? -1 : 1));
                }
              }}
            >
              <span className="gh-title" title={run.label}>
                {run.label}
              </span>
              <span className="hint">
                {c.done}/{c.total}
                {c.failed > 0 && ` · ${c.failed} failed`}
              </span>
              <button className="small head-close" draggable={false} aria-label={`Hide ${run.label}`} title="Hide this column" onClick={() => onHide(run.label)}>
                ×
              </button>
              <ResizeHandle label={run.label} measure={measure(run.label)} onResize={(px) => setWidth(run.label, px)} onReset={() => clearWidth(run.label)} />
            </div>
          );
        })}

        {(mode === "text" || !hasBlocks) && !readOnlyOld ? (
          <div className="source-editor-slot" style={{ gridRow: `2 / span ${rows + 1}`, gridColumn: 1 }}>
            <SourceEditor
              key={editorKey}
              value={text}
              onChange={onText}
              blocks={previewBlocks}
              placeholder="Paste or type the text here, add a model, then press Run."
            />
          </div>
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
