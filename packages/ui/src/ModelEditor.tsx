import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";
import type { ModelSetting, PromptPreset } from "@ltw/domain";
import { allPrompts } from "@ltw/domain/pure";
import { Pick } from "./Pick";
import { newModel, type SetupState } from "./setup";

/** A labelled field: what it is above, the box below, and a hint if it needs one. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="1" title={hint}>
      <Text size="1" color="gray">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/** Add a model, or change one's settings. */
export function ModelEditor({
  initial,
  setup,
  discovered,
  takenNames,
  live = false,
  onSave,
  onCancel,
}: {
  /** null: adding a new model. */
  initial: ModelSetting | null;
  setup: Pick<SetupState, "prompts">;
  /** Model names the server listed. */
  discovered: string[];
  /** Names already in use by other models. */
  takenNames: Set<string>;
  /** Apply every valid change straight away instead of waiting for a Save button. */
  live?: boolean;
  onSave: (m: ModelSetting) => void;
  onCancel: () => void;
}) {
  const [m, setM] = useState<ModelSetting>(initial ?? newModel(""));
  const styles: PromptPreset[] = allPrompts(setup.prompts);
  const problemOf = (x: ModelSetting): string | null =>
    x.name.trim() === "" ? "Enter the model name" : takenNames.has(x.name.trim()) ? "A model with this name is already added" : x.maxOutputTokens >= x.contextLimit ? "The reply limit must be smaller than the context" : null;
  const problem = problemOf(m);
  const set = (patch: Partial<ModelSetting>) => {
    const next = { ...m, ...patch };
    setM(next);
    if (live && problemOf(next) === null) onSave({ ...next, name: next.name.trim() });
  };
  const number = (value: number, onChange: (n: number) => void, props: { min: number; step: number; max?: number }) => (
    <TextField.Root size="2" type="number" min={props.min} step={props.step} {...(props.max !== undefined ? { max: props.max } : {})} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave({ ...m, name: m.name.trim() });
      }}
    >
      <Flex direction="column" gap="3">
        <Field label="Model">
          {discovered.length > 0 ? (
            <Pick label="Model" value={m.name} options={[...new Set([...(m.name ? [m.name] : []), ...discovered])].map((d) => ({ value: d, label: d }))} onChange={(name) => set({ name })} />
          ) : (
            <TextField.Root size="2" autoFocus={!live} value={m.name} placeholder="Exact name in LM Studio" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
          )}
        </Field>
        <Field label="Style">
          <Pick label="Translation style" value={m.promptId} options={styles.map((p) => ({ value: p.id, label: p.name }))} onChange={(promptId) => set({ promptId })} />
        </Field>
        <div className="model-numbers">
          <Field label="Context" hint="The context size this model is loaded with in LM Studio. It is not reported, so enter it yourself.">
            {number(m.contextLimit, (n) => set({ contextLimit: Math.floor(n) }), { min: 512, step: 256 })}
          </Field>
          <Field label="Reply limit" hint="The most text the model may write for one block. Thinking models need room for their thinking too.">
            {number(m.maxOutputTokens, (n) => set({ maxOutputTokens: Math.floor(n) }), { min: 128, step: 128 })}
          </Field>
          <Field label="Temperature">{number(m.temperature, (n) => set({ temperature: n }), { min: 0, max: 2, step: 0.1 })}</Field>
        </div>
        {live ? (
          problem && (
            <Text size="1" color="amber">
              {problem}
            </Text>
          )
        ) : (
          <Flex justify="end" align="center" gap="2">
            {problem && (
              <Text size="1" color="gray">
                {problem}
              </Text>
            )}
            <Button type="button" variant="soft" color="gray" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null}>
              {initial ? "Save" : "Add"}
            </Button>
          </Flex>
        )}
      </Flex>
    </form>
  );
}
