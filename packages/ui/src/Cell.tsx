import { useState } from "react";
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

export function Badge({ state }: { state: keyof typeof STATUS }) {
  const s = STATUS[state];
  return (
    <span className={`badge badge-${state}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}

/** One model's result for one block. */
export function Cell({ cell, actions, runLabel, blockNumber }: { cell: BlockCellView; actions: CellActions; runLabel: string; blockNumber: number }) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const inProgress = cell.state === "running" || cell.state === "pending" || cell.state === "waiting";
  const label = `${runLabel}, block ${blockNumber}`;

  if (editing) {
    return (
      <div className="cell">
        <textarea
          className="edit-box"
          aria-label={`Edit ${label}`}
          value={draftText}
          autoFocus
          onChange={(e) => setDraftText(e.target.value)}
        />
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              actions.edit(draftText);
              setEditing(false);
            }}
          >
            Save edit
          </button>
          <button onClick={() => setEditing(false)}>Cancel edit</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`cell cell-${cell.state}`}>
      <div className="cell-head">
        <Badge state={cell.state} />
        {cell.edited && <span className="tag">Edited by you</span>}
        {cell.attempts > 1 && <span className="tag">{cell.attempts} attempts</span>}
      </div>

      {cell.state === "needs_review" && (
        <div className="note">
          {cell.reviewNotes.length > 0 ? (
            <>
              <p>Worth a look before you rely on this:</p>
              <ul className="plain">
                {cell.reviewNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <p className="muted">These checks are hints and can be wrong. Edit the text, retry, or accept it as is.</p>
            </>
          ) : (
            <p>The model stopped early or declined, so this may be incomplete. Check it, edit it, or accept it as is.</p>
          )}
        </div>
      )}
      {cell.state === "stale" && (
        <p className="note">The text before this block changed after it was translated. It may no longer fit; retranslate it if it matters.</p>
      )}
      {cell.state === "failed" && (
        <p className="note error-note">
          {cell.error ?? "This block failed."}
          {cell.text !== null && " Retry failed; the earlier result is kept below."}
        </p>
      )}
      {cell.state === "waiting" && <p className="note">Waiting for the model (see the message above).</p>}
      {cell.state === "pending" && <p className="muted">Queued.</p>}

      {cell.text !== null && <p className="text">{cell.text}</p>}

      {cell.draft !== null && (
        <div className="draft">
          <span className="tag">{cell.state === "running" ? (cell.text !== null ? "New attempt (draft)" : "Draft") : "Incomplete draft, not a result"}</span>
          <p className="text">
            {cell.draft}
            {cell.state === "running" && <span className="caret" aria-hidden="true" />}
          </p>
        </div>
      )}

      {cell.candidateText !== null && (
        <div className="candidate" role="group" aria-label={`New version of ${label}`}>
          <span className="tag">New version ready</span>
          <p className="text">{cell.candidateText}</p>
          <div className="actions">
            <button className="primary" onClick={actions.acceptCandidate}>
              Use new version
            </button>
            <button onClick={actions.keepCurrent}>Keep current</button>
          </div>
        </div>
      )}

      <div className="actions">
        {cell.state === "running" || cell.state === "pending" ? (
          <button onClick={actions.cancel} aria-label={`Cancel ${label}`}>
            Cancel block
          </button>
        ) : null}
        {cell.state === "needs_review" && (
          <button onClick={actions.acceptReview} aria-label={`Accept ${label} as is`}>
            Accept as is
          </button>
        )}
        {!inProgress || cell.state === "waiting" ? (
          <button onClick={actions.retry} aria-label={`Retry ${label}`}>
            Retry
          </button>
        ) : null}
        {cell.text !== null && cell.state !== "running" && (
          <button
            onClick={() => {
              setDraftText(cell.text ?? "");
              setEditing(true);
            }}
            aria-label={`Edit ${label}`}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}
