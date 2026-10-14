import { useState } from "react";
import { DotsHorizontalIcon, PlusIcon } from "@radix-ui/react-icons";
import { Badge, Box, Button, DropdownMenu, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import type { DocumentView } from "@ltw/domain";

/** The project's documents (chapters, scenes...), at the top of the left panel. Click one to open it. */
export function Documents({
  documents,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  documents: DocumentView[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");

  const commit = (d: DocumentView) => {
    const next = name.trim();
    setRenaming(null);
    if (next !== "" && next !== d.title) onRename(d.id, next);
  };
  const startRename = (d: DocumentView) => {
    setName(d.title);
    setRenaming(d.id);
  };

  return (
    <Box asChild px="3" pt="3" pb="2">
      <section aria-label="Documents">
        <Flex align="center" justify="between" mb="1">
          <Text size="1" weight="bold" color="gray" className="rail-title">
            DOCUMENTS
          </Text>
          <IconButton variant="ghost" color="gray" size="1" aria-label="New document" title="New document" onClick={onCreate}>
            <PlusIcon />
          </IconButton>
        </Flex>
        <Flex asChild direction="column" gap="1">
          <ul className="plain-list">
            {documents.map((d) => {
              const active = d.id === activeId;
              return (
                <li key={d.id}>
                  <Flex align="center" gap="1">
                    {renaming === d.id ? (
                      <TextField.Root
                        size="1"
                        style={{ flex: 1 }}
                        aria-label={`Rename ${d.title}`}
                        value={name}
                        autoFocus
                        onChange={(e) => setName(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={() => commit(d)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit(d);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <Button
                        variant={active ? "soft" : "ghost"}
                        color={active ? "indigo" : "gray"}
                        size="2"
                        style={{ flex: 1, justifyContent: "flex-start", minWidth: 0 }}
                        aria-current={active ? "true" : undefined}
                        title={d.title}
                        onClick={() => onSelect(d.id)}
                        onDoubleClick={() => startRename(d)}
                      >
                        <Text truncate>{d.title}</Text>
                        {d.total > 0 ? (
                          <Badge variant="soft" color={d.done === d.total ? "green" : "gray"} size="1">
                            {d.done}/{d.total}
                          </Badge>
                        ) : (
                          !d.hasText && (
                            <Text size="1" color="gray">
                              empty
                            </Text>
                          )
                        )}
                      </Button>
                    )}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        <IconButton variant="ghost" color="gray" size="1" aria-label={`Actions for ${d.title}`}>
                          <DotsHorizontalIcon />
                        </IconButton>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item onSelect={() => startRename(d)}>Rename</DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item color="red" onSelect={() => onDelete(d.id)}>
                          Delete…
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </Flex>
                </li>
              );
            })}
          </ul>
        </Flex>
      </section>
    </Box>
  );
}
