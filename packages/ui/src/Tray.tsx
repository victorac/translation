import type { WorkspaceSnapshot } from "@ltw/domain";
import { countCells, STATUS } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

interface Item {
  runId: string;
  label: string;
  blockId: string;
  n: number;
  state: keyof typeof STATUS;
  message: string;
}

/** A one-line summary that opens into the list of things that need attention. */
export function Tray({ snap, open, onToggle, send }: { snap: WorkspaceSnapshot; open: boolean; onToggle: () => void; send: Send }) {
  const c = countCells(snap);
  const items: Item[] = [];
  for (const run of snap.runs) {
    snap.revision?.blocks.forEach((b) => {
      const cell = run.blocks[b.id];
      if (!cell || ["succeeded", "pending", "running"].includes(cell.state)) return;
      const message =
        cell.state === "failed" ? (cell.error ?? "Failed") : cell.state === "needs_review" ? (cell.reviewNotes[0] ?? "Check this block") : cell.state === "stale" ? "The text before it changed" : STATUS[cell.state].label;
      items.push({ runId: run.id, label: run.label, blockId: b.id, n: b.index + 1, state: cell.state, message });
    });
  }
  const parts = [`${c.done}/${c.total} blocks`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.review) parts.push(`${c.review} to review`);
  if (c.stale) parts.push(`${c.stale} out of date`);
  if (c.canceled) parts.push(`${c.canceled} canceled`);

  return (
    <section className={open ? "tray open" : "tray"} aria-label="Progress and problems">
      <button className="tray-bar" onClick={onToggle} aria-expanded={open}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span role="status">{c.total === 0 ? "Nothing translated yet" : parts.join(" · ")}</span>
        {items.length > 0 && !open && <span className="count">{items.length}</span>}
      </button>
      {open && (
        <ul className="tray-list">
          {items.length === 0 && <li className="hint">Nothing needs attention.</li>}
          {items.slice(0, 200).map((it) => (
            <li key={`${it.runId}:${it.blockId}`}>
              <span className={`state state-${it.state}`}>
                <span aria-hidden="true">{STATUS[it.state].icon}</span> {STATUS[it.state].label}
              </span>
              <span className="tray-where">
                {it.label} · block {it.n}
              </span>
              <span className="tray-msg ellipsis" title={it.message}>
                {it.message}
              </span>
              <button className="small" onClick={() => document.getElementById(`block-${it.n}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>
                Go
              </button>
              <button className="small" onClick={() => void send("block.retry", { runId: it.runId, blockId: it.blockId })}>
                Retry
              </button>
            </li>
          ))}
          {items.length > 200 && <li className="hint">…and {items.length - 200} more</li>}
        </ul>
      )}
    </section>
  );
}
