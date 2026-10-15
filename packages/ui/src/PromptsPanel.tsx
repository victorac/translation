import { useState } from "react";
import { Button, Callout, Card, Checkbox, Code, Flex, Text, TextArea, TextField } from "@radix-ui/themes";
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
    <Flex direction="column" gap="3">
      <Text size="2" color="gray">
        Instructions given to the model. Choose a style for each model in the left panel. <Code size="1">{"{sourceLanguage}"}</Code> and <Code size="1">{"{targetLanguage}"}</Code> are filled in.
      </Text>

      <Flex direction="column" gap="2">
        {BUILTIN_PROMPTS.map((p) => (
          <Card key={p.id} size="1">
            <Flex align="center" justify="between" gap="2" wrap="wrap">
              <Flex direction="column">
                <Text size="2" weight="bold">
                  {p.name}
                </Text>
                <Text size="1" color="gray">
                  {p.description}
                </Text>
              </Flex>
              <Flex gap="1">
                <Button size="1" variant="soft" color="gray" onClick={() => setViewing(viewing === p.id ? null : p.id)} aria-expanded={viewing === p.id}>
                  {viewing === p.id ? "Hide text" : "Show text"}
                </Button>
                <Button size="1" variant="soft" onClick={() => setEditing({ ...p, id: newId(), name: `${p.name} (copy)` })}>
                  Copy to edit
                </Button>
              </Flex>
            </Flex>
            {viewing === p.id && (
              <Text as="p" size="1" color="gray" mt="2" style={{ whiteSpace: "pre-wrap" }}>
                {p.template}
              </Text>
            )}
          </Card>
        ))}
        {custom.map((p) => (
          <Card key={p.id} size="1">
            <Flex align="center" justify="between" gap="2">
              <Flex direction="column">
                <Text size="2" weight="bold">
                  {p.name}
                </Text>
                <Text size="1" color="gray">
                  yours
                </Text>
              </Flex>
              <Flex gap="1">
                <Button size="1" variant="soft" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <Button size="1" variant="soft" color="red" onClick={() => window.confirm(`Delete the prompt "${p.name}"?`) && onChange(custom.filter((c) => c.id !== p.id))}>
                  Delete
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>

      {editing ? (
        <Card>
          <Flex direction="column" gap="3">
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                Name
              </Text>
              <TextField.Root size="2" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Flex>
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                Instructions
              </Text>
              <TextArea size="2" rows={8} value={editing.template} onChange={(e) => setEditing({ ...editing, template: e.target.value })} />
            </Flex>
            {problem && editing.name !== "" && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{problem}</Callout.Text>
              </Callout.Root>
            )}
            <Flex gap="2">
              <Button onClick={save} disabled={!!problem}>
                Save prompt
              </Button>
              <Button variant="soft" color="gray" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </Flex>
          </Flex>
        </Card>
      ) : (
        <Flex>
          <Button variant="soft" onClick={() => setEditing({ id: newId(), name: "", description: "", template: "" })}>
            New prompt
          </Button>
        </Flex>
      )}
    </Flex>
  );
}
