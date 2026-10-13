import { useEffect, useRef, useState } from "react";
import type { GlossaryEntry, ModelSetting } from "@ltw/domain";
import { mergeAnalysis } from "@ltw/domain/pure";
import { api } from "./api";
import type { SetupState } from "./setup";

/**
 * Lets a model read the text, one block at a time, and suggest the people and notes that help with pronouns and
 * who is speaking. Everything it finds is added to the lists below, where it can be edited.
 */
export function NotesAssistant({
  setup,
  passages,
  glossary,
  notes,
  onGlossary,
  onNotes,
}: {
  setup: Pick<SetupState, "backend" | "sourceLanguage" | "targetLanguage" | "models">;
  /** The blocks of the open text. */
  passages: readonly string[];
  glossary: GlossaryEntry[];
  notes: string;
  onGlossary: (g: GlossaryEntry[]) => void;
  onNotes: (n: string) => void;
}) {
  const names = setup.models.map((m) => m.name).filter((n) => n.trim() !== "");
  const [chosen, setChosen] = useState<string | null>(null);
  const model: ModelSetting | undefined = setup.models.find((m) => m.name === (chosen ?? names[0]));
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef({ glossary, notes });
  latest.current = progress ? latest.current : { glossary, notes };
  const stopped = useRef(false);
  useEffect(
    () => () => {
      stopped.current = true;
      void api.invoke("notes.cancel");
    },
    [],
  );

  const read = async () => {
    if (!model) return;
    stopped.current = false;
    setMessage(null);
    let people = 0;
    let facts = 0;
    const count = (n: string) => n.match(/^- /gm)?.length ?? 0;
    for (let i = 0; i < passages.length; i++) {
      if (stopped.current) break;
      setProgress({ at: i + 1, of: passages.length });
      const res = await api.invoke("notes.analyze", {
        backend: setup.backend,
        modelId: model.name,
        contextLimit: model.contextLimit,
        maxOutputTokens: model.maxOutputTokens,
        sourceLanguage: setup.sourceLanguage,
        targetLanguage: setup.targetLanguage,
        passage: passages[i]!,
        glossary: latest.current.glossary,
        notes: latest.current.notes,
      });
      if (!res.ok) {
        setMessage({ text: res.error.message, error: true });
        break;
      }
      if (res.value.canceled || stopped.current) break;
      const before = latest.current;
      const next = mergeAnalysis(before, res.value);
      people += next.glossary.length - before.glossary.length;
      facts += count(next.notes) - count(before.notes);
      latest.current = next;
      if (next.glossary !== before.glossary) onGlossary(next.glossary);
      if (next.notes !== before.notes) onNotes(next.notes);
    }
    setProgress(null);
    setMessage((m) => m ?? { text: people + facts === 0 ? "Nothing new was found." : `Added ${people} ${people === 1 ? "person" : "people"} and ${facts} ${facts === 1 ? "note" : "notes"}. Please check them; the model can be wrong.`, error: false });
  };

  return (
    <div className="stack notes-assistant">
      {names.length > 1 && !progress && (
        <label>
          Model to read with
          <select value={model?.name ?? ""} onChange={(e) => setChosen(e.target.value)}>
            {names.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      )}
      <div className="actions">
        {progress ? (
          <>
            <span className="hint">
              Reading block {progress.at} of {progress.of}…
            </span>
            <button
              onClick={() => {
                stopped.current = true;
                void api.invoke("notes.cancel");
              }}
            >
              Stop
            </button>
          </>
        ) : (
          <button onClick={() => void read()} disabled={!model || passages.length === 0} title="The model reads the text and suggests who is who. You can edit everything it adds.">
            Suggest notes from the text
          </button>
        )}
      </div>
      {!model && <p className="hint">Add a model first.</p>}
      {model && passages.length === 0 && <p className="hint">Add some text first.</p>}
      {message && (
        <p className={message.error ? "note error-note" : "hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
