import type { Backend } from "@ltw/domain";
import type { useProvider } from "./useProvider";

/** One line at the bottom of the rail: is the model server reachable? Click to check again. */
export function ConnectionStatus({ backend, provider, onSettings }: { backend: Backend; provider: ReturnType<typeof useProvider>; onSettings: () => void }) {
  if (backend === "practice") {
    return (
      <div className="conn">
        <span className="dot dot-idle" aria-hidden="true">
          ○
        </span>
        <span className="hint">Practice mode</span>
      </div>
    );
  }
  const { view, test, testing } = provider;
  const ok = test?.ok === true;
  const text = testing ? "Checking…" : ok ? `Connected · ${test!.models.length} model${test!.models.length === 1 ? "" : "s"}` : view?.problem ? "Server address problem" : "Not connected";
  return (
    <div className="conn" role="status">
      <span className={`dot ${ok ? "dot-done" : testing ? "dot-running" : "dot-issues"}`} aria-hidden="true">
        {ok ? "●" : testing ? "◔" : "○"}
      </span>
      <span className="conn-text" title={test?.message ?? view?.problem ?? ""}>
        {text}
      </span>
      <button className="link-button" onClick={() => (ok || testing ? void provider.refresh() : onSettings())}>
        {ok || testing ? "Refresh" : "Fix"}
      </button>
    </div>
  );
}
