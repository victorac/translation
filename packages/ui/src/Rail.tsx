import { useState } from "react";
import { Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
import { Badge, Box, Button, Card, Flex, IconButton, Text } from "@radix-ui/themes";
import type { WorkspaceSnapshot } from "@ltw/domain";
import { ConnectionStatus } from "./ConnectionStatus";
import { Documents } from "./Documents";
import { ModelEditor } from "./ModelEditor";
import { newModel, type SetupState } from "./setup";
import type { useProvider } from "./useProvider";

/** The left panel: the project's documents, the models that can translate, and whether the model server is reachable. */
export function Rail({
  snap,
  setup,
  onSetup,
  discovered,
  provider,
  onSettings,
  docs,
}: {
  snap: WorkspaceSnapshot | null;
  setup: SetupState;
  onSetup: (s: SetupState) => void;
  discovered: string[];
  provider: ReturnType<typeof useProvider>;
  onSettings: () => void;
  docs: {
    onSelect: (id: string) => void;
    onCreate: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
  };
}) {
  const [adding, setAdding] = useState(false);
  const [openName, setOpenName] = useState<string | null>(null);
  const taken = (except: number) => new Set(setup.models.filter((_, i) => i !== except).map((m) => m.name));

  return (
    <Flex asChild direction="column" className="rail">
      <nav aria-label="Documents and models">
        {snap && <Documents documents={snap.documents} activeId={snap.activeDocumentId} onSelect={docs.onSelect} onCreate={docs.onCreate} onRename={docs.onRename} onDelete={docs.onDelete} />}

        <Box px="3" pt="3" pb="2">
          <Flex align="center" justify="between" mb="1">
            <Text size="1" weight="bold" color="gray" className="rail-title">
              MODELS
            </Text>
            <IconButton variant="ghost" color="gray" size="1" aria-label={adding ? "Cancel adding a model" : "Add a model"} title="Add a model" aria-expanded={adding} onClick={() => setAdding((x) => !x)}>
              {adding ? <Cross2Icon /> : <PlusIcon />}
            </IconButton>
          </Flex>

          {adding && (
            <Card mb="2" size="1">
              {discovered.length > 0 && (
                <Box mb="3">
                  <Text size="1" color="gray" as="p" mb="1">
                    From the server. Click to add.
                  </Text>
                  <Flex wrap="wrap" gap="1">
                    {discovered.map((id) => {
                      const has = taken(-1).has(id);
                      return (
                        <Button
                          key={id}
                          size="1"
                          variant="soft"
                          color="gray"
                          disabled={has}
                          onClick={() => {
                            onSetup({ ...setup, models: [...setup.models, newModel(id)] });
                            setAdding(false);
                          }}
                        >
                          {has ? "✓" : "+"} {id}
                        </Button>
                      );
                    })}
                  </Flex>
                  <Text size="1" color="gray" as="p" mt="2">
                    …or type a name below.
                  </Text>
                </Box>
              )}
              <ModelEditor
                initial={null}
                setup={setup}
                discovered={discovered}
                takenNames={taken(-1)}
                onSave={(m) => {
                  onSetup({ ...setup, models: [...setup.models, m] });
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </Card>
          )}

          {setup.models.length === 0 && !adding && (
            <Text size="2" color="gray" as="p">
              Add a model to start.
            </Text>
          )}
          <Flex asChild direction="column" gap="1">
            <ul className="plain-list">
              {setup.models.map((m, i) => (
                <li key={m.name}>
                  <Flex align="center" gap="1" className="model-row">
                    <Button variant={openName === m.name ? "soft" : "ghost"} color="gray" size="2" style={{ flex: 1, justifyContent: "flex-start", minWidth: 0 }} aria-expanded={openName === m.name} title={m.name} onClick={() => setOpenName(openName === m.name ? null : m.name)}>
                      <Text truncate>{m.name}</Text>
                      {m.promptId !== "standard" && (
                        <Badge variant="soft" color="gray" size="1">
                          {m.promptId}
                        </Badge>
                      )}
                    </Button>
                    <IconButton variant="ghost" color="gray" size="1" aria-label={`Remove ${m.name}`} title="Remove this model" onClick={() => onSetup({ ...setup, models: setup.models.filter((_, n) => n !== i) })}>
                      <Cross2Icon />
                    </IconButton>
                  </Flex>
                  {openName === m.name && (
                    <Box mt="2" mb="2" ml="2">
                      <ModelEditor live initial={m} setup={setup} discovered={discovered} takenNames={taken(i)} onSave={(next) => onSetup({ ...setup, models: setup.models.map((x, n) => (n === i ? next : x)) })} onCancel={() => setOpenName(null)} />
                    </Box>
                  )}
                </li>
              ))}
            </ul>
          </Flex>
        </Box>

        <Box style={{ flex: 1 }} />
        <ConnectionStatus backend={setup.backend} provider={provider} onSettings={onSettings} />
      </nav>
    </Flex>
  );
}
