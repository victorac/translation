import { useState } from "react";
import type { ModelSetting, PromptPreset } from "@ltw/domain";
import { allPrompts } from "@ltw/domain/pure";
import { labelOf, newModel, type SetupState } from "./setup";

/** Add a model, or change one's settings. Settings apply to new runs; an existing run keeps what it was made with. */
export function ModelEditor({
  initial,
  setup,
  discovered,
  takenLabels,
  existingRun,
  onSave,
  onCancel,
}: {
  /** null: adding a new model. */
  initial: ModelSetting | null;
  setup: Pick<SetupState, "prompts" | "glossary">;
  /** Model names the server listed. */
  discovered: string[];
  /** Labels already in use by other models. */
  takenLabels: Set<string>;
  existingRun: boolean;
  onSave: (m: ModelSetting) => void;
  onCancel: () => void;
}) {
  const [m, setM] = useState<ModelSetting>(initial ?? newModel(""));
  const styles: PromptPreset[] = allPrompts(setup.prompts);
  const label = labelOf(m, setup);
  const problem =
    m.name.trim() === ""
      ? "Enter the model name"
      : takenLabels.has(label)
        ? "Already added with these settings"
        : m.maxOutputTokens >= m.contextLimit
          ? "The reply limit must be smaller than the context"
          : null;
  const set = (patch: Partial<ModelSetting>) => setM({ ...m, ...patch });
  const listId = "discovered-models";

  return (
    <form
      className="model-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave({ ...m, name: m.name.trim() });
      }}
    >
      <label>
        Model
        <input
          autoFocus
          list={listId}
          value={m.name}
          placeholder="Exact name in LM Studio"
          onChange={(e) => set({ name: e.target.value })}
          spellCheck={false}
          disabled={existingRun}
        />
        <datalist id={listId}>
          {discovered.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </label>
      <div className="two">
        <label>
          Style
          <select value={m.promptId} onChange={(e) => set({ promptId: e.target.value })} disabled={existingRun}>
            {styles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check pad-top">
          <input type="checkbox" checked={m.useGlossary} onChange={(e) => set({ useGlossary: e.target.checked })} disabled={existingRun} />
          Glossary
        </label>
      </div>
      <div className="three">
        <label title="The context size this model is loaded with in LM Studio. It is not reported, so enter it yourself.">
          Context
          <input type="number" min={512} step={256} value={m.contextLimit} onChange={(e) => set({ contextLimit: Math.floor(Number(e.target.value)) })} />
        </label>
        <label title="The most text the model may write for one block. Thinking models need room for their thinking too.">
          Reply limit
          <input type="number" min={128} step={128} value={m.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: Math.floor(Number(e.target.value)) })} />
        </label>
        <label>
          Temp.
          <input type="number" min={0} max={2} step={0.1} value={m.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} />
        </label>
      </div>
      {existingRun && <p className="hint">Limits apply to new runs. Use “Run again” to redo this model with them. To try another style, add the model again.</p>}
      <div className="row-end">
        {problem && <span className="hint">{problem}</span>}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!!problem}>
          {initial ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
