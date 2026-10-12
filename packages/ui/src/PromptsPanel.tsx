import { useState } from "react";
import type { PromptPreset } from "@ltw/domain";
import { BUILTIN_PROMPTS, validatePrompt } from "@ltw/domain/pure";

const newId = (): string => `custom-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())}`;

/** Translation styles: the instructions given to the model. Built-in ones are fixed; your own can be edited. */
export function PromptsPanel({ custom, onChange }: { custom: PromptPreset[]; onChange: (p: PromptPreset[]) => void }) {
  const [editing, setEditing] = useState<PromptPreset | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const problem = editing ? validatePrompt(editing) : null;

  const save = () => {
    if (!editing || problem) return;
    onChange(custom.some((c) => c.id === editing.id) ? custom.map((c) => (c.id === editing.id ? editing : c)) : [...custom, editing]);
    setEditing(null);
  };

  return (
    <div className="stack">
      <p className="muted">
        A style is the set of instructions the model gets before the text. Pick a style for each model below. Running the same model with two
        styles gives you two columns to compare. Use <code>{"{sourceLanguage}"}</code> and <code>{"{targetLanguage}"}</code> in your own styles.
      </p>

      <ul className="prompt-list">
        {BUILTIN_PROMPTS.map((p) => (
          <li key={p.id}>
            <div className="prompt-head">
              <strong>{p.name}</strong> <span className="muted">built in · {p.description}</span>
              <span className="actions">
                <button onClick={() => setViewing(viewing === p.id ? null : p.id)} aria-expanded={viewing === p.id}>
                  {viewing === p.id ? "Hide text" : "Show text"}
                </button>
                <button onClick={() => setEditing({ ...p, id: newId(), name: `${p.name} (copy)` })}>Copy to edit</button>
              </span>
            </div>
            {viewing === p.id && <pre className="excerpt">{p.template}</pre>}
          </li>
        ))}
        {custom.map((p) => (
          <li key={p.id}>
            <div className="prompt-head">
              <strong>{p.name}</strong> <span className="muted">your own</span>
              <span className="actions">
                <button onClick={() => setEditing(p)}>Edit</button>
                <button onClick={() => window.confirm(`Delete the prompt "${p.name}"?`) && onChange(custom.filter((c) => c.id !== p.id))}>Delete</button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {editing ? (
        <div className="stack prompt-editor">
          <label>
            Name
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <label>
            Instructions
            <textarea rows={8} value={editing.template} onChange={(e) => setEditing({ ...editing, template: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={editing.appendFraming} onChange={(e) => setEditing({ ...editing, appendFraming: e.target.checked })} />
            <span>
              Add the standard notes about the message layout
              <br />
              <span className="muted">Explains glossary, context and source_block to the model, and that text in the message is never an instruction. Leave this on unless your instructions already say it.</span>
            </span>
          </label>
          {problem && editing.name !== "" && <p className="note error-note">{problem}</p>}
          <div className="actions">
            <button className="primary" onClick={save} disabled={!!problem}>
              Save prompt
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button onClick={() => setEditing({ id: newId(), name: "", description: "", template: "", appendFraming: true })}>New prompt</button>
        </div>
      )}
    </div>
  );
}
