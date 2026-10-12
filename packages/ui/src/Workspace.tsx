import type { CancelInput, WorkspaceSnapshot } from "@ltw/domain";
import { Cell } from "./Cell";
import { countCells, summarize, WAITING_HELP } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

export function Workspace({ snap, send }: { snap: WorkspaceSnapshot; send: Send }) {
  const revision = snap.revision!;
  const cancel = (input: CancelInput) => void send("job.cancel", input);

  return (
    <div className="workspace">
      {snap.waiting && (
        <div className="banner waiting-banner" role="alert">
          <strong>{snap.waiting.label} is waiting.</strong> {snap.waiting.message}
          {!snap.waiting.message.includes("Retry") && <p>{WAITING_HELP[snap.waiting.code] ?? "Fix the problem, then press Retry."}</p>}
          <div className="actions">
            {snap.backend === "practice" && snap.waiting.code === "model_unavailable" && (
              <button onClick={() => void send("demo.loadModel")} disabled={!snap.demoModelUnloaded}>
                {snap.demoModelUnloaded ? "Practice mode: load the model" : "Practice model loaded"}
              </button>
            )}
            <button className="primary" onClick={() => void send("run.resolveWaiting", { runId: snap.waiting!.runId, resolution: "retry" })}>
              Retry
            </button>
            <button onClick={() => void send("run.resolveWaiting", { runId: snap.waiting!.runId, resolution: "skip" })}>Skip this model</button>
          </div>
        </div>
      )}
      {snap.job?.stopReason && (
        <div className="banner error-banner" role="alert">
          Translation stopped: {snap.job.stopReason}
        </div>
      )}

      <div className="grid-scroll">
        <div className="grid" style={{
            gridTemplateColumns: `3.5rem minmax(14rem, 1fr) ${snap.runs.map(() => "minmax(16rem, 1.2fr)").join(" ")}`,
            minWidth: `calc(17.5rem + ${snap.runs.length} * 16rem)`,
          }}>
          <div className="grid-head corner" />
          <div className="grid-head">
            <h2>Source</h2>
            <p className="muted">
              {revision.sourceLanguage} · {revision.blocks.length} blocks
            </p>
          </div>
          {snap.runs.map((run) => {
            const c = countCells(snap, run.id);
            const unfinished = Object.values(run.blocks).some((b) => ["failed", "canceled", "pending", "waiting"].includes(b.state));
            return (
              <div className="grid-head" key={run.id}>
                <h2>{run.label}</h2>
                <p className="muted">
                  {revision.targetLanguage} · style: {run.promptName} · {runStateText(run.state)} · {c.done}/{c.total} done
                  {c.failed > 0 && ` · ${c.failed} failed`}
                  {c.canceled > 0 && ` · ${c.canceled} canceled`}
                </p>
                <div className="actions">
                  {snap.busy && ["running", "waiting", "queued"].includes(run.state) && (
                    <button onClick={() => cancel({ kind: "run", runId: run.id })} aria-label={`Cancel model ${run.label}`}>
                      Cancel model
                    </button>
                  )}
                  {!snap.busy && unfinished && (
                    <button onClick={() => void send("run.retryUnfinished", { runId: run.id })} aria-label={`Retry unfinished blocks of ${run.label}`}>
                      {run.state === "interrupted" ? "Resume unfinished" : "Retry unfinished"}
                    </button>
                  )}
                  {!snap.busy && c.stale > 0 && (
                    <button onClick={() => void send("run.retranslateDownstream", { runId: run.id })} aria-label={`Retranslate out-of-date blocks of ${run.label}`}>
                      Retranslate out-of-date
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {revision.blocks.map((block) => (
            <div className="grid-row" key={block.id} style={{ display: "contents" }}>
              <div className="row-num" id={`block-${block.index + 1}`}>
                <span className="sr-only">Block </span>
                {block.index + 1}
              </div>
              <div className="source-cell">
                <p className="text">{block.text}</p>
                <p className="muted">~{block.estimatedTokens} tokens</p>
              </div>
              {snap.runs.map((run) => (
                <Cell
                  key={run.id}
                  cell={run.blocks[block.id]!}
                  runLabel={run.label}
                  blockNumber={block.index + 1}
                  actions={{
                    retry: () => void send("block.retry", { runId: run.id, blockId: block.id }),
                    cancel: () => cancel({ kind: "block", runId: run.id, blockId: block.id }),
                    edit: (text) => void send("block.edit", { runId: run.id, blockId: block.id, text }),
                    acceptCandidate: () => void send("block.acceptCandidate", { runId: run.id, blockId: block.id }),
                    keepCurrent: () => void send("block.keepCurrent", { runId: run.id, blockId: block.id }),
                    acceptReview: () => void send("block.acceptReview", { runId: run.id, blockId: block.id }),
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {summarize(countCells(snap))}
      </p>
    </div>
  );
}

function runStateText(state: string): string {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "translating";
    case "waiting":
      return "waiting";
    case "completed":
      return "finished";
    case "completed_with_issues":
      return "finished with problems";
    case "canceled":
      return "canceled";
    case "interrupted":
      return "stopped (can be resumed)";
    default:
      return state;
  }
}
