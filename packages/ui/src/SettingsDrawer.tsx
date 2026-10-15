import {
  useEffect,
  useRef,
} from "react";
import {
  Cross2Icon,
} from "@radix-ui/react-icons";
import {
  Flex,
  IconButton,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes";
import {
  Connection,
} from "./Connection";
import {
  PromptsPanel,
} from "./PromptsPanel";
import {
  newModel,
  type SetupState,
} from "./setup";
import type {
  useProvider,
} from "./useProvider";

export type SettingsTab = "server" | "text" | "styles";

/** A labelled field: what it is above, the box below. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="1" title={hint}>
      <Text size="2" weight="medium">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/** Everything that is configured rather than done. Opens beside the work, never replaces it. */
export function SettingsDrawer({
  tab,
  onTab,
  onClose,
  setup,
  onSetup,
  provider,
}: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  setup: SetupState;
  onSetup: (update: (s: SetupState) => SetupState) => void;
  provider: ReturnType<typeof useProvider>;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("[role=listbox], [role=menu]") && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<SetupState>) => onSetup((s) => ({ ...s, ...patch }));

  return (
    <aside className="drawer" role="dialog" aria-label="Settings" tabIndex={-1} ref={ref}>
      <Tabs.Root value={tab} onValueChange={(v) => onTab(v as SettingsTab)}>
        <Flex align="center" justify="between" pr="3" className="drawer-head">
          <Tabs.List size="2">
            <Tabs.Trigger value="server">Server</Tabs.Trigger>
            <Tabs.Trigger value="text">Text</Tabs.Trigger>
            <Tabs.Trigger value="styles">Styles</Tabs.Trigger>
          </Tabs.List>
          <IconButton variant="ghost" color="gray" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
            <Cross2Icon />
          </IconButton>
        </Flex>

        <div className="drawer-body">
          <Tabs.Content value="server">
            <Connection
              backend={setup.backend}
              onBackend={(backend) => set({ backend, models: backend === "practice" ? [newModel("practice-model-a")] : [] })}
              provider={provider}
              onAddModel={(name) => !setup.models.some((m) => m.name === name) && set({ models: [...setup.models, newModel(name)] })}
              haveModel={(name) => setup.models.some((m) => m.name === name)}
            />
          </Tabs.Content>

          <Tabs.Content value="text">
            <Flex direction="column" gap="4">
              <Flex gap="3">
                <Field label="From">
                  <TextField.Root size="2" value={setup.sourceLanguage} onChange={(e) => set({ sourceLanguage: e.target.value })} />
                </Field>
                <Field label="To">
                  <TextField.Root size="2" value={setup.targetLanguage} onChange={(e) => set({ targetLanguage: e.target.value })} />
                </Field>
              </Flex>
            </Flex>
          </Tabs.Content>

          <Tabs.Content value="styles">
            <PromptsPanel
              custom={setup.prompts}
              onChange={(prompts) => {
                const ids = new Set(["standard", "literary", "literal", "nuance", ...prompts.map((p) => p.id)]);
                set({ prompts, models: setup.models.map((m) => (ids.has(m.promptId) ? m : { ...m, promptId: "standard" })) });
              }}
            />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </aside>
  );
}
