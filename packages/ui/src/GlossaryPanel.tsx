import { useState } from "react";
import type { GlossaryEntry } from "@ltw/domain";
import { normalizeGlossary, parseGlossaryText } from "@ltw/domain/pure";

/** The names and terms that must be translated the same way every time. */
export function GlossaryPanel({ value, onChange, notes, onNotes }: { value: GlossaryEntry[]; onChange: (g: GlossaryEntry[]) => void; notes: string; onNotes: (n: string) => void }) {
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
      <label>
        Story notes
        <textarea
          rows={5}
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
          placeholder={"Sent with every block. For example:\nHanako is a girl who speaks very politely.\nThe narrator is a boy; he speaks casually.\nMost lines are spoken by Hanako or the narrator."}
        />
      </label>
      <p className="hint">
        Names and terms. Add a hint to a name, such as "girl, polite speech"; it is sent whenever that name appears. Terms to translate the same way every time. Use <code>|</code> for alternatives (<code>Demon King|Demon Lord</code>). A block is flagged if a required term is missing; that check is a hint.
      </p>

      {value.length > 0 && (
        <table className="glossary-table">
          <thead>
            <tr>
              <th scope="col">Source term</th>
              <th scope="col">Translate as</th>
              <th scope="col">Hint (optional)</th>
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
                  <input aria-label={`Hint ${i + 1}`} placeholder="e.g. girl, speaks politely" value={e.note ?? ""} onChange={(ev) => update(i, { note: ev.target.value })} />
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
        Paste a list
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
        <span className="hint">=, → or tab between sides; # for a note</span>
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
