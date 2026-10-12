import { useState } from "react";
import type { Backend, DemoOptions, ModelSetting } from "@ltw/domain";
import type { useProvider } from "./useProvider";

export interface SetupState {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  backend: Backend;
  models: ModelSetting[];
  demo: DemoOptions;
}

export const newModel = (name: string): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2 });

export const initialSetup: SetupState = {
  text: "",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "provider",
  models: [],
  demo: { speed: "normal", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false },
};

const SAMPLE =
  "「やっぱり、そうなんだね」\n彼女は小さく笑った。窓の外では雨が降り続いていた。\n\n「ずっと、そう思ってた。でも、言えなかったの。」\n「そっか。」\n\n***\n\n翌朝、彼は駅で彼女を待っていた。電車は定刻通りに到着したが、彼女の姿はなかった。\n\n彼は携帯電話を取り出し、短いメッセージを書いた。「今どこにいる？」";

const isLocalHost = (address: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname);
  } catch {
    return true; // not a valid address yet: the server-side check explains the problem
  }
};

export function Setup({ value, onChange, provider }: { value: SetupState; onChange: (v: SetupState) => void; provider: ReturnType<typeof useProvider> }) {
  const [newName, setNewName] = useState("");
  const set = (patch: Partial<SetupState>) => onChange({ ...value, ...patch });
  const setDemo = (patch: Partial<DemoOptions>) => set({ demo: { ...value.demo, ...patch } });
  const addModel = (name: string) => {
    const n = name.trim();
    if (n && !value.models.some((m) => m.name === n) && value.models.length < 8) set({ models: [...value.models, newModel(n)] });
    setNewName("");
  };
  const updateModel = (name: string, patch: Partial<ModelSetting>) =>
    set({ models: value.models.map((m) => (m.name === name ? { ...m, ...patch } : m)) });
  const chooseBackend = (backend: Backend) => set({ backend, models: backend === "practice" ? [newModel("practice-model-a")] : [] });

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

        <section className="panel" aria-labelledby="h-conn">
          <h2 id="h-conn">3. Connect to a model server</h2>
          <fieldset className="choice">
            <legend className="sr-only">Translator</legend>
            <label className="check">
              <input type="radio" name="backend" checked={value.backend === "provider"} onChange={() => chooseBackend("provider")} />
              LM Studio or another local server
            </label>
            <label className="check">
              <input type="radio" name="backend" checked={value.backend === "practice"} onChange={() => chooseBackend("practice")} />
              Practice translator (fake, for trying the app)
            </label>
          </fieldset>
          {value.backend === "provider" ? <Connection provider={provider} /> : <p className="muted">Nothing is sent anywhere. The practice translator just echoes the text back with a label.</p>}
        </section>

        <section className="panel" aria-labelledby="h-models">
          <h2 id="h-models">4. Models</h2>
          <p className="muted">
            Each model translates the same blocks, one model after another. Load only one at a time in LM Studio if your graphics card is small.
          </p>
          {value.models.length > 0 && (
            <ul className="model-list">
              {value.models.map((m) => (
                <li key={m.name} className="model-row">
                  <div className="model-name">
                    <strong>{m.name}</strong>
                    <button aria-label={`Remove ${m.name}`} onClick={() => set({ models: value.models.filter((x) => x.name !== m.name) })}>
                      Remove
                    </button>
                  </div>
                  <div className="model-fields">
                    <label>
                      Context size (tokens)
                      <input type="number" min={512} step={256} value={m.contextLimit} onChange={(e) => updateModel(m.name, { contextLimit: Math.floor(Number(e.target.value)) })} />
                    </label>
                    <label>
                      Longest reply (tokens)
                      <input type="number" min={16} step={128} value={m.maxOutputTokens} onChange={(e) => updateModel(m.name, { maxOutputTokens: Math.floor(Number(e.target.value)) })} />
                    </label>
                    <label>
                      Temperature
                      <input type="number" min={0} max={2} step={0.1} value={m.temperature} onChange={(e) => updateModel(m.name, { temperature: Number(e.target.value) })} />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {value.backend === "provider" && value.models.length > 0 && (
            <p className="muted">
              Context size must match what the model is loaded with in LM Studio. LM Studio does not report it, so the app cannot check. If it is set too high, requests will fail with a context error.
            </p>
          )}
          <div className="row">
            <input
              aria-label="Model name"
              placeholder={value.backend === "provider" ? "Exact model name, e.g. qwen2.5-7b-instruct" : "Add another model name"}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addModel(newName))}
            />
            <button onClick={() => addModel(newName)} disabled={value.models.length >= 8 || newName.trim() === ""}>
              Add model
            </button>
          </div>
          {provider.test?.ok && provider.test.models.length > 0 && value.backend === "provider" && (
            <div className="discovered">
              <p className="muted">Models the server listed (listed does not mean loaded):</p>
              <ul className="chips">
                {provider.test.models.map((id) => (
                  <li key={id}>
                    <button className="chip-add" onClick={() => addModel(id)} disabled={value.models.some((m) => m.name === id) || value.models.length >= 8}>
                      + {id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {value.backend === "practice" && (
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
        )}
      </div>
    </div>
  );
}

function Connection({ provider }: { provider: ReturnType<typeof useProvider> }) {
  const view = provider.view;
  const [address, setAddress] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState<boolean | null>(null);
  if (!view) return <p className="muted">Loading…</p>;

  const shownAddress = address ?? view.baseUrl;
  const local = isLocalHost(shownAddress);
  const approved = allowRemote ?? view.remoteAllowed;
  const test = () =>
    void provider.saveAndTest({
      baseUrl: shownAddress,
      allowRemote: local ? false : approved,
      ...(key !== null ? { apiKey: key } : {}),
    });

  return (
    <div className="stack">
      <label>
        Server address
        <input
          value={shownAddress}
          onChange={(e) => {
            setAddress(e.target.value);
            provider.clearTest();
          }}
          spellCheck={false}
        />
      </label>
      <p className="muted">LM Studio: open the Developer tab, start the server, and use its address. The default is http://localhost:1234/v1.</p>

      {!local && (
        <div className="banner warn-box" role="group" aria-label="Server is not on this computer">
          <p>
            <strong>This address is not on this computer.</strong> The text you translate would be sent over the network to it.
          </p>
          <label className="check">
            <input type="checkbox" checked={approved} onChange={(e) => setAllowRemote(e.target.checked)} />I understand, and I allow sending text to this server
          </label>
        </div>
      )}

      <label>
        API key (optional)
        <input
          type="password"
          autoComplete="off"
          placeholder={view.hasApiKey && key === null ? "A key is saved. Type to replace it." : "Not needed for LM Studio by default"}
          value={key ?? ""}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      {view.hasApiKey && key === null && (
        <button className="link-button" onClick={() => setKey("")}>
          Remove the saved key
        </button>
      )}

      <div className="actions">
        <button className="primary" onClick={test} disabled={provider.testing}>
          {provider.testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {provider.saveError && <p className="note error-note">{provider.saveError}</p>}
        {provider.test && (
          <p className={provider.test.ok ? "note ok-note" : "note error-note"}>
            <span aria-hidden="true">{provider.test.ok ? "✓ " : "✕ "}</span>
            {provider.test.message}
          </p>
        )}
        {view.problem && !provider.test && !provider.saveError && <p className="note error-note">{view.problem}</p>}
      </div>
    </div>
  );
}
