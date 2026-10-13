import { useState, type ReactNode } from "react";
import type { BlockCellView } from "@ltw/domain";
import { STATUS } from "./status";

export interface CellActions {
  retry(): void;
  cancel(): void;
  edit(text: string): void;
  acceptCandidate(): void;
  keepCurrent(): void;
  acceptReview(): void;
}

export function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button className={danger ? "icon-button danger-text" : "icon-button"} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** One model's result for one block. Quiet when all is well; says what is wrong when it is not. */
export function Cell({ cell, actions, label, n }: { cell: BlockCellView; actions: CellActions; label: string; n: number }) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const where = `${label}, block ${n}`;
  const busy = cell.state === "running" || cell.state === "pending";
  const s = STATUS[cell.state];
  const quiet = cell.state === "succeeded";

  if (editing) {
    return (
      <div className="cell out editing">
        <textarea className="edit-box" aria-label={`Edit ${where}`} value={draftText} autoFocus onChange={(e) => setDraftText(e.target.value)} />
        <div className="row-end">
          <button onClick={() => setEditing(false)}>Cancel</button>
          <button
            className="primary"
            onClick={() => {
              actions.edit(draftText);
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`cell out st-${cell.state}`}>
      <div className="cell-actions">
        {busy && (
          <IconButton label={`Cancel ${where}`} onClick={actions.cancel}>
            ■
          </IconButton>
        )}
        {!busy && (
          <IconButton label={`Retry ${where}`} onClick={actions.retry}>
            ↻
          </IconButton>
        )}
        {cell.text !== null && !busy && (
          <IconButton
            label={`Edit ${where}`}
            onClick={() => {
              setDraftText(cell.text ?? "");
              setEditing(true);
            }}
          >
            ✎
          </IconButton>
        )}
      </div>

      {quiet ? <span className="sr-only">{s.label}. </span> : <span className={`state state-${cell.state}`}><span aria-hidden="true">{s.icon}</span> {s.label}{cell.state === "failed" && cell.error ? ` · ${cell.error}` : ""}</span>}
      {cell.edited && <span className="tag">edited</span>}
      {cell.outdated && (
        <span className="tag warn-tag" title="The glossary or settings changed after this was translated. Run to update it, or retry this block.">
          older settings
        </span>
      )}
      {cell.attempts > 1 && quiet && <span className="tag">{cell.attempts} tries</span>}

      {cell.state === "needs_review" && cell.reviewNotes.length > 0 && (
        <ul className="notes" title={cell.reviewNotes.join("\n")}>
          {cell.reviewNotes.slice(0, 2).map((n2, i) => (
            <li key={i}>{n2}</li>
          ))}
          {cell.reviewNotes.length > 2 && <li className="hint">+{cell.reviewNotes.length - 2} more</li>}
        </ul>
      )}

      {cell.text !== null && <p className="text">{cell.text}</p>}

      {cell.draft !== null && (
        <p className="text draft" aria-label={cell.state === "running" ? "Draft" : "Incomplete draft"}>
          {cell.draft}
          {cell.state === "running" && <span className="caret" aria-hidden="true" />}
        </p>
      )}

      {cell.state === "needs_review" && (
        <button className="small" onClick={actions.acceptReview} aria-label={`Accept ${where} as is`}>
          Accept
        </button>
      )}

      {cell.candidateText !== null && (
        <div className="candidate" role="group" aria-label={`New version of ${where}`}>
          <span className="tag">new version</span>
          <p className="text">{cell.candidateText}</p>
          <div className="row">
            <button className="small primary" onClick={actions.acceptCandidate}>
              Use
            </button>
            <button className="small" onClick={actions.keepCurrent}>
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
