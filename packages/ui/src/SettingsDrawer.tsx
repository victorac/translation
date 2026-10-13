import { useEffect, useRef } from "react";
import type { Backend, BlockSize, DemoOptions, SplitPreview } from "@ltw/domain";
import { Connection } from "./Connection";
import { PromptsPanel } from "./PromptsPanel";
import { SplitPreviewView } from "./SplitPreviewView";
import { newModel, type SetupState } from "./setup";
import type { useProvider } from "./useProvider";

export type SettingsTab = "server" | "text" | "styles" | "practice";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "server", label: "Server" },
  { id: "text", label: "Text" },
  { id: "styles", label: "Styles" },
];

/** Everything that is configured rather than done. Opens beside the work, never replaces it. */
export function SettingsDrawer({
  tab,
  onTab,
  onClose,
  setup,
  onSetup,
  provider,
  split,
}: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  setup: SetupState;
  onSetup: (update: (s: SetupState) => SetupState) => void;
  provider: ReturnType<typeof useProvider>;
  split: { preview: SplitPreview | null; loading: boolean };
}) {
  const ref = useRef<HTMLElement>(null);
  const tabs = setup.backend === "practice" ? [...TABS, { id: "practice" as const, label: "Practice" }] : TABS;

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest(".popover") && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<SetupState>) => onSetup((s) => ({ ...s, ...patch }));
  const setDemo = (patch: Partial<DemoOptions>) => set({ demo: { ...setup.demo, ...patch } });

  return (
    <aside className="drawer" role="dialog" aria-label="Settings" tabIndex={-1} ref={ref}>
      <header className="drawer-head">
        <div role="tablist" aria-label="Settings sections" className="tabs">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => onTab(t.id)}>
              {t.label}
              
              {t.id === "styles" && setup.prompts.length > 0 && <span className="count">{setup.prompts.length}</span>}
            </button>
          ))}
        </div>
        <button className="icon-button" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="drawer-body" role="tabpanel">
        {tab === "server" && (
          <Connection
            backend={setup.backend}
            onBackend={(backend) => set({ backend, models: backend === "practice" ? [newModel("practice-model-a")] : [] })}
            provider={provider}
            onAddModel={(name) => !setup.models.some((m) => m.name === name && m.promptId === "standard") && set({ models: [...setup.models, newModel(name)] })}
            haveModel={(name) => setup.models.some((m) => m.name === name)}
          />
        )}

        {tab === "text" && (
          <div className="stack">
            <div className="two">
              <label>
                From
                <input value={setup.sourceLanguage} onChange={(e) => set({ sourceLanguage: e.target.value })} />
              </label>
              <label>
                To
                <input value={setup.targetLanguage} onChange={(e) => set({ targetLanguage: e.target.value })} />
              </label>
            </div>
            <label title="Smaller blocks need less context and fail in smaller pieces. Larger blocks keep more together. A model with a small context can still force smaller blocks.">
              Block size
              <select value={setup.blockSize} onChange={(e) => set({ blockSize: e.target.value as BlockSize })}>
                <option value="small">Smaller</option>
                <option value="normal">Normal</option>
                <option value="large">Larger</option>
              </select>
            </label>
            <h3>How the text will be split</h3>
            <SplitPreviewView preview={split.preview} loading={split.loading} />
          </div>
        )}


        {tab === "styles" && (
          <PromptsPanel
            custom={setup.prompts}
            onChange={(prompts) => {
              const ids = new Set(["standard", "literary", "literal", "nuance", ...prompts.map((p) => p.id)]);
              set({ prompts, models: setup.models.map((m) => (ids.has(m.promptId) ? m : { ...m, promptId: "standard" })) });
            }}
          />
        )}

        {tab === "practice" && (
          <div className="stack">
            <label>
              Speed
              <select value={setup.demo.speed} onChange={(e) => setDemo({ speed: e.target.value as DemoOptions["speed"] })}>
                <option value="fast">Fast</option>
                <option value="normal">Normal</option>
                <option value="slow">Slow</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={setup.demo.smallBlocks} onChange={(e) => setDemo({ smallBlocks: e.target.checked })} />
              Tiny blocks
            </label>
            <label>
              First model fails once in block
              <input
                type="number"
                min={1}
                placeholder="none"
                value={setup.demo.failBlockOnce ?? ""}
                onChange={(e) => setDemo({ failBlockOnce: e.target.value === "" ? null : Math.max(1, Math.floor(Number(e.target.value))) })}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={setup.demo.firstModelUnloaded} onChange={(e) => setDemo({ firstModelUnloaded: e.target.checked })} />
              First model starts “not loaded”
            </label>
          </div>
        )}
      </div>
    </aside>
  );
}
