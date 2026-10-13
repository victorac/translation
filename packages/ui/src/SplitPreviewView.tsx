import type { SplitPreview } from "@ltw/domain";
import { AWKWARD_BOUNDARIES, BOUNDARY_PHRASE } from "@ltw/domain/pure";

/** Shows the blocks the text will be translated in, and why they are that size. */
export function SplitPreviewView({ preview, loading }: { preview: SplitPreview | null; loading: boolean }) {
  if (!preview) {
    return <p className="muted">{loading ? "Working out the split…" : "Paste some text to see how it will be split into blocks."}</p>;
  }
  if (preview.problem && preview.blocks.length === 0) return <p className="note error-note">{preview.problem}</p>;

  const tokens = preview.blocks.map((b) => b.estimatedTokens);
  const average = tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0;
  const largest = tokens.length ? Math.max(...tokens) : 0;

  return (
    <div className="stack split-preview" aria-busy={loading}>
      <p role="status" className="split-summary">
        <strong>
          {preview.blocks.length} block{preview.blocks.length === 1 ? "" : "s"}
        </strong>{" "}
        · about <span title="Estimates: one token per character, which is cautious.">{average} tokens</span> each (largest {largest}, at most {preview.maxTokens})
        {preview.limitingModel && (
          <>
            {" "}
            · size set by <strong>{preview.limitingModel}</strong>
          </>
        )}
        {loading && <span className="muted"> · updating…</span>}
      </p>
      {preview.problem && <p className="note error-note">{preview.problem}</p>}
      {preview.issues.map((m, i) => (
        <p className="note error-note" key={i} role="alert">
          {m}
        </p>
      ))}
      {preview.notes.map((m, i) => (
        <p className="note" key={i}>
          {m}
        </p>
      ))}

      {preview.models.length > 0 && (
        <details>
          <summary>How much fits in each model</summary>
          <table className="glossary-table budget-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Context</th>
                <th scope="col">Kept for the reply</th>
                <th scope="col">Instructions + glossary + margin</th>
                <th scope="col">Left for each block</th>
              </tr>
            </thead>
            <tbody>
              {preview.models.map((m) => (
                <tr key={m.label}>
                  <th scope="row">{m.label}</th>
                  <td>{m.contextLimit.toLocaleString()}</td>
                  <td>{m.outputReserve.toLocaleString()}</td>
                  <td>{m.fixedTokens.toLocaleString()}</td>
                  <td>{m.fits ? m.sourceBudget.toLocaleString() : <strong>nothing: does not fit</strong>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <ol className="block-list">
        {preview.blocks.map((b) => {
          const trailing = /\n+$/.exec(b.text)?.[0] ?? "";
          const body = trailing ? b.text.slice(0, -trailing.length) : b.text;
          const awkward = AWKWARD_BOUNDARIES.has(b.boundaryKind);
          return (
            <li key={b.index} className={awkward ? "block-item awkward" : "block-item"}>
              <div className="block-meta">
                <span className="block-number">Block {b.index + 1}</span>
                <span className="muted">~{b.estimatedTokens} tokens</span>
                <span className={awkward ? "boundary awkward-text" : "boundary muted"}>
                  {awkward && <span aria-hidden="true">⚠ </span>}
                  {BOUNDARY_PHRASE[b.boundaryKind]}
                </span>
              </div>
              <p className="text block-text">
                {body}
                {trailing && (
                  <span className="ws" aria-label={`${trailing.length} line break${trailing.length === 1 ? "" : "s"}`}>
                    {"↵".repeat(trailing.length)}
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
