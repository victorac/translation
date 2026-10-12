import type { BlockState, WorkspaceSnapshot } from "@ltw/domain";

/** Every status has words and a symbol, so nothing depends on color alone. */
export const STATUS: Record<BlockState, { label: string; icon: string }> = {
  pending: { label: "Pending", icon: "○" },
  waiting: { label: "Waiting", icon: "⏸" },
  running: { label: "Translating", icon: "◔" },
  succeeded: { label: "Done", icon: "✓" },
  needs_review: { label: "Needs review", icon: "⚠" },
  failed: { label: "Failed", icon: "✕" },
  canceled: { label: "Canceled", icon: "■" },
  stale: { label: "Out of date", icon: "↻" },
};

export interface Counts {
  total: number;
  done: number;
  failed: number;
  canceled: number;
  review: number;
  stale: number;
}

export function countCells(snap: WorkspaceSnapshot, runId?: string): Counts {
  const c: Counts = { total: 0, done: 0, failed: 0, canceled: 0, review: 0, stale: 0 };
  for (const run of snap.runs) {
    if (runId && run.id !== runId) continue;
    for (const cell of Object.values(run.blocks)) {
      c.total++;
      if (cell.state === "succeeded") c.done++;
      else if (cell.state === "failed") c.failed++;
      else if (cell.state === "canceled") c.canceled++;
      else if (cell.state === "needs_review") c.review++;
      else if (cell.state === "stale") c.stale++;
    }
  }
  return c;
}

export function summarize(c: Counts): string {
  const parts = [`${c.done} of ${c.total} blocks done`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.canceled) parts.push(`${c.canceled} canceled`);
  if (c.review) parts.push(`${c.review} need review`);
  if (c.stale) parts.push(`${c.stale} out of date`);
  return parts.join(" · ");
}

export const WAITING_HELP: Record<string, string> = {
  model_unavailable: "Load the model in LM Studio (or start its server), then press Retry.",
  connection: "Check that the LM Studio server is running at the configured address, then press Retry.",
  auth: "The server refused the credentials. Fix the API key in the provider settings, then press Retry.",
  context_overflow: "The text did not fit the model's context. Use smaller blocks, raise the confirmed context, or shorten the glossary, then press Retry.",
};
