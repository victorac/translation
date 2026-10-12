import { useState } from "react";
import type { DemoOptions } from "@ltw/domain";

export interface SetupState {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  models: string[];
  demo: DemoOptions;
}

export const initialSetup: SetupState = {
  text: "",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  models: ["practice-model-a"],
  demo: { speed: "normal", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false },
};

const SAMPLE =
  "「やっぱり、そうなんだね」\n彼女は小さく笑った。窓の外では雨が降り続いていた。\n\n「ずっと、そう思ってた。でも、言えなかったの。」\n「そっか。」\n\n***\n\n翌朝、彼は駅で彼女を待っていた。電車は定刻通りに到着したが、彼女の姿はなかった。\n\n彼は携帯電話を取り出し、短いメッセージを書いた。「今どこにいる？」";

export function Setup({ value, onChange }: { value: SetupState; onChange: (v: SetupState) => void }) {
  const [newModel, setNewModel] = useState("");
  const set = (patch: Partial<SetupState>) => onChange({ ...value, ...patch });
  const setDemo = (patch: Partial<DemoOptions>) => set({ demo: { ...value.demo, ...patch } });
  const addModel = () => {
    const m = newModel.trim();
    if (m && !value.models.includes(m) && value.models.length < 8) set({ models: [...value.models, m] });
    setNewModel("");
  };

  return (
    <div className="setup">
      <section className="panel source-panel" aria-labelledby="h-source">
        <h2 id="h-source">1. Paste the text to translate</h2>
        <textarea
          className="source-input"
          aria-label="Source text"
          placeholder="Paste or type the text here…"
          value={value.text}
          onChange={(e) => set({ text: e.target.value })}
        />
        <div className="actions">
          <button onClick={() => set({ text: SAMPLE })}>Use a sample passage</button>
          <span className="muted">{value.text.length.toLocaleString()} characters</span>
        </div>
      </section>

      <div className="setup-side">
        <section className="panel" aria-labelledby="h-lang">
          <h2 id="h-lang">2. Languages</h2>
          <div className="row">
            <label>
              From
              <input value={value.sourceLanguage} onChange={(e) => set({ sourceLanguage: e.target.value })} />
            </label>
            <label>
              To
              <input value={value.targetLanguage} onChange={(e) => set({ targetLanguage: e.target.value })} />
            </label>
          </div>
        </section>

        <section className="panel" aria-labelledby="h-models">
          <h2 id="h-models">3. Models</h2>
          <p className="muted">
            Each model translates the same blocks, one model after another. Connecting to LM Studio is not built yet: for now every model name
            uses a built-in <strong>practice translator</strong>.
          </p>
          <ul className="chips">
            {value.models.map((m) => (
              <li key={m} className="chip">
                {m}
                <button aria-label={`Remove ${m}`} onClick={() => set({ models: value.models.filter((x) => x !== m) })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <input
              aria-label="Model name"
              placeholder="Add another model name"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addModel())}
            />
            <button onClick={addModel} disabled={value.models.length >= 8}>
              Add model
            </button>
          </div>
        </section>

        <section className="panel" aria-labelledby="h-demo">
          <h2 id="h-demo">Practice-mode controls</h2>
          <div className="stack">
            <label>
              Speed
              <select value={value.demo.speed} onChange={(e) => setDemo({ speed: e.target.value as DemoOptions["speed"] })}>
                <option value="fast">Fast</option>
                <option value="normal">Normal</option>
                <option value="slow">Slow (easier to cancel)</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={value.demo.smallBlocks} onChange={(e) => setDemo({ smallBlocks: e.target.checked })} />
              Use small blocks (so a short text still splits into several)
            </label>
            <label>
              The first model fails partway through block number
              <input
                type="number"
                min={1}
                placeholder="none"
                value={value.demo.failBlockOnce ?? ""}
                onChange={(e) => setDemo({ failBlockOnce: e.target.value === "" ? null : Math.max(1, Math.floor(Number(e.target.value))) })}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={value.demo.firstModelUnloaded} onChange={(e) => setDemo({ firstModelUnloaded: e.target.checked })} />
              The first model starts "not loaded" (shows the Waiting state)
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}
