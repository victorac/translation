import { useState } from "react";
import type { Backend } from "@ltw/domain";
import type { useProvider } from "./useProvider";

const isLocalHost = (address: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname);
  } catch {
    return true; // not a valid address yet: the background process explains the problem
  }
};

/** The model server: address, optional key, and a test that lists its models. */
export function Connection({
  backend,
  onBackend,
  provider,
  onAddModel,
  haveModel,
}: {
  backend: Backend;
  onBackend: (b: Backend) => void;
  provider: ReturnType<typeof useProvider>;
  onAddModel: (name: string) => void;
  haveModel: (name: string) => boolean;
}) {
  const view = provider.view;
  const [address, setAddress] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState<boolean | null>(null);

  return (
    <div className="stack">
      <div className="segmented" role="radiogroup" aria-label="Translator">
        <button role="radio" aria-checked={backend === "provider"} className={backend === "provider" ? "on" : ""} onClick={() => onBackend("provider")}>
          LM Studio
        </button>
        <button role="radio" aria-checked={backend === "practice"} className={backend === "practice" ? "on" : ""} onClick={() => onBackend("practice")} title="A fake translator for trying the app. Nothing is sent anywhere.">
          Practice
        </button>
      </div>

      {backend === "practice" ? (
        <p className="hint">Echoes the text with a label. Nothing leaves this computer.</p>
      ) : !view ? (
        <p className="hint">Loading…</p>
      ) : (
        (() => {
          const shown = address ?? view.baseUrl;
          const local = isLocalHost(shown);
          const approved = allowRemote ?? view.remoteAllowed;
          const test = () => void provider.saveAndTest({ baseUrl: shown, allowRemote: local ? false : approved, ...(key !== null ? { apiKey: key } : {}) });
          return (
            <>
              <label>
                Address
                <input
                  value={shown}
                  spellCheck={false}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    provider.clearTest();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && test()}
                />
              </label>
              {!local && (
                <label className="check warn-line">
                  <input type="checkbox" checked={approved} onChange={(e) => setAllowRemote(e.target.checked)} />
                  <span>
                    This is not your computer. Allow sending text to <strong>{(() => { try { return new URL(shown).host; } catch { return shown; } })()}</strong>.
                  </span>
                </label>
              )}
              <label>
                API key <span className="hint">optional</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={view.hasApiKey && key === null ? "Saved. Type to replace." : ""}
                  value={key ?? ""}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              {view.hasApiKey && key === null && (
                <button className="link-button" onClick={() => setKey("")}>
                  Remove saved key
                </button>
              )}
              <div className="row">
                <button className="primary" onClick={test} disabled={provider.testing}>
                  {provider.testing ? "Testing…" : "Test connection"}
                </button>
              </div>
              <div role="status" aria-live="polite" className="stack tight">
                {provider.saveError && <p className="note error-note">{provider.saveError}</p>}
                {provider.test && (
                  <p className={provider.test.ok ? "note ok-note" : "note error-note"}>
                    <span aria-hidden="true">{provider.test.ok ? "✓ " : "✕ "}</span>
                    {provider.test.message}
                  </p>
                )}
                {view.problem && !provider.test && !provider.saveError && <p className="note error-note">{view.problem}</p>}
              </div>
              {provider.test?.ok && provider.test.models.length > 0 && (
                <div>
                  <p className="hint">Listed models (listed is not loaded). Click to add:</p>
                  <ul className="chips">
                    {provider.test.models.map((id) => (
                      <li key={id}>
                        <button className="chip" onClick={() => onAddModel(id)} disabled={haveModel(id)}>
                          {haveModel(id) ? "✓ " : "+ "}
                          {id}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}
