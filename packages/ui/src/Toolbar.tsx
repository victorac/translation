import { useEffect, useRef, useState } from "react";
import { GearIcon } from "@radix-ui/react-icons";
import { Badge, Button, DropdownMenu, Flex, IconButton, Spinner, Text, TextField } from "@radix-ui/themes";
import { api } from "./api";
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

/** What the app is doing for the user: in words, and whether it can be stopped. */
export interface Activity {
  what: string;
  stop: boolean;
}

/** What the model is doing right now, with how long it has been at it and a way to stop it. */
function Working({ what, stop }: Activity) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [what]);
  return (
    <Flex align="center" gap="2" minWidth="0" role="status" aria-live="polite">
      <Spinner size="1" />
      <Text size="2" color="gray" truncate>
        {what}… {seconds}s
      </Text>
      {stop && (
        <Button variant="ghost" color="gray" size="1" onClick={() => void api.invoke("notes.cancel")} title="Stop what the model is doing">
          Stop
        </Button>
      )}
    </Flex>
  );
}

/** The top line: the project's name on the left; on the right the knowledge base, the file menu (open, save, export) and the settings. */
export function Toolbar({
  snap,
  send,
  onSettings,
  onExport,
  confirmDiscard,
  activity,
  knowledge,
}: {
  snap: WorkspaceSnapshot | null;
  send: Send;
  onSettings: () => void;
  onExport: () => void;
  confirmDiscard: (what: string) => boolean;
  /** What the model is doing for the user right now; null when it is idle. */
  activity: Activity | null;
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

        <Flex align="center" gap="4" minWidth="0">
          {activity && <Working what={activity.what} stop={activity.stop} />}
          <Button variant={knowledge.open ? "solid" : "soft"} color="gray" aria-pressed={knowledge.open} onClick={knowledge.onToggle} title="Show or hide the glossary: the names and terms of this text, and every entry of the project">
            Glossary
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
