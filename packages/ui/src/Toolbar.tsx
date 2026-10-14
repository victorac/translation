import { useEffect, useRef, useState } from "react";
import { GearIcon } from "@radix-ui/react-icons";
import { Badge, Button, DropdownMenu, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import type { WorkspaceSnapshot } from "@ltw/domain";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

/** The project's name, which becomes a field to rename it when clicked. */
function ProjectName({ title, path, onRename }: { title: string; path: string | null; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(title), [title]);
  useEffect(() => {
    if (editing) box.current?.select();
  }, [editing]);
  const done = (save: boolean) => {
    setEditing(false);
    if (save && value.trim() !== title) onRename(value);
    else setValue(title);
  };
  return editing ? (
    <TextField.Root
      ref={box}
      size="2"
      aria-label="Project name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  ) : (
    <Button variant="ghost" color="gray" size="2" title={`${path ?? "Not saved yet"}\nClick to rename`} onClick={() => setEditing(true)}>
      <Text weight="bold" truncate>
        {title}
      </Text>
    </Button>
  );
}

/** The top line: the project's name on the left; on the right the knowledge base, the file menu (open, save, export) and the settings. */
export function Toolbar({
  snap,
  send,
  onSettings,
  onExport,
  confirmDiscard,
  knowledge,
}: {
  snap: WorkspaceSnapshot | null;
  send: Send;
  onSettings: () => void;
  onExport: () => void;
  confirmDiscard: (what: string) => boolean;
  /** The knowledge base pane: whether it is showing, how many entries there are, and how many are waiting to be checked. */
  knowledge: { open: boolean; count: number; suggested: number; onToggle: () => void };
}) {
  const project = snap?.project;
  const hasContent = !!snap && (snap.documents.some((d) => d.hasText || d.total > 0) || snap.knowledge.terms > 0);

  return (
    <Flex asChild align="center" justify="between" gap="4" px="4" py="2" className="toolbar">
      <header>
        <Flex align="center" gap="3" minWidth="0">
          <ProjectName title={project?.title ?? "Untitled"} path={project?.path ?? null} onRename={(title) => void send("project.rename", { title })} />
          {project?.dirty && (
            <Text color="amber" size="2" title="Unsaved changes" aria-label="Unsaved changes" role="img">
              ●
            </Text>
          )}
        </Flex>

        <Flex align="center" gap="4">
          <Button variant={knowledge.open ? "solid" : "soft"} color="gray" aria-pressed={knowledge.open} onClick={knowledge.onToggle} title="Show or hide the knowledge base">
            Knowledge base
            {knowledge.count > 0 && <Badge variant="soft">{knowledge.count}</Badge>}
            {knowledge.suggested > 0 && (
              <Badge color="amber" variant="soft">
                {knowledge.suggested} to check
              </Badge>
            )}
          </Button>
          <Flex align="center" gap="2">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Button variant="soft" color="gray">
                  File
                  <DropdownMenu.TriggerIcon />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item disabled={!!project?.recovery} onSelect={() => confirmDiscard("Opening another project") && void send("project.open", { useBackup: false })}>
                  Open…
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={!hasContent} onSelect={() => void send("project.save", { saveAs: false })}>
                  Save
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={!hasContent} onSelect={() => void send("project.save", { saveAs: true })}>
                  Save as…
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={!hasContent} onSelect={onExport}>
                  Export translation…
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => confirmDiscard("Starting a new project") && void send("project.new")}>New project</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <IconButton variant="ghost" color="gray" onClick={onSettings} aria-label="Settings" title="Settings">
              <GearIcon />
            </IconButton>
          </Flex>
        </Flex>
      </header>
    </Flex>
  );
}
