import { useState } from "react";
import type { GlossaryEntry } from "@ltw/domain";
import { normalizeGlossary, parseGlossaryText } from "@ltw/domain/pure";

/** The names and terms that must be translated the same way every time. */
export function GlossaryPanel({ value, onChange }: { value: GlossaryEntry[]; onChange: (g: GlossaryEntry[]) => void }) {
  const [paste, setPaste] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const problems = normalizeGlossary(value).problems;

  const update = (i: number, patch: Partial<GlossaryEntry>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const addFromText = () => {
    const r = parseGlossaryText(paste);
    setSkipped(r.skipped);
    if (r.entries.length > 0) onChange([...value.filter((e) => e.source.trim() !== "" || e.target.trim() !== ""), ...r.entries]);
    if (r.skipped.length === 0) setPaste("");
  };

  return (
    <div className="stack">
      <p className="muted">
        Names and terms that must be translated the same way every time. Each request carries only the entries whose source term appears in that
        block. Write alternatives with <code>|</code>, for example <code>Demon King|Demon Lord</code>: the first is asked for and any counts as correct.
        After translating, a block is flagged for review if a required term is missing. That check is a hint and can be wrong.
      </p>

      {value.length > 0 && (
        <table className="glossary-table">
          <thead>
            <tr>
              <th scope="col">Source term</th>
              <th scope="col">Translate as</th>
              <th scope="col">Note (optional)</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {value.map((e, i) => (
              <tr key={i}>
                <td>
                  <input aria-label={`Source term ${i + 1}`} value={e.source} onChange={(ev) => update(i, { source: ev.target.value })} />
                </td>
                <td>
                  <input aria-label={`Translation ${i + 1}`} value={e.target} onChange={(ev) => update(i, { target: ev.target.value })} />
                </td>
                <td>
                  <input aria-label={`Note ${i + 1}`} value={e.note ?? ""} onChange={(ev) => update(i, { note: ev.target.value })} />
                </td>
                <td>
                  <button aria-label={`Remove glossary entry ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="actions">
        <button onClick={() => onChange([...value, { source: "", target: "" }])}>Add a term</button>
        {value.length > 0 && <button onClick={() => window.confirm("Remove every glossary entry?") && onChange([])}>Clear all</button>}
      </div>

      {problems.length > 0 && (
        <p className="note error-note" role="alert">
          {problems.slice(0, 3).join(" ")}
        </p>
      )}

      <label>
        Or paste a list, one per line
        <textarea
          rows={4}
          placeholder={"魔王 = Demon King\nアレン → Allen # the hero"}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
      </label>
      <div className="actions">
        <button onClick={addFromText} disabled={paste.trim() === ""}>
          Add these terms
        </button>
        <span className="muted">Use =, -&gt;, → or a tab between the two sides, and # for a note.</span>
      </div>
      {skipped.length > 0 && (
        <p className="note error-note" role="alert">
          These lines were not understood and were left in the box: {skipped.slice(0, 3).join(" · ")}
          {skipped.length > 3 && ` …and ${skipped.length - 3} more`}
        </p>
      )}
    </div>
  );
}
