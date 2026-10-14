import { useEffect, useRef, useState } from "react";
import { GearIcon } from "@radix-ui/react-icons";
import { Badge, Button, DropdownMenu, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import type { WorkspaceSnapshot } from "@ltw/domain";
import { Pick } from "./Pick";
import { countCells } from "./status";
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

/**
 * The top line: the project's name on the left; on the right the two ways of translating, the knowledge base, the file menu
 * (open, save, export) and the settings.
 */
export function Toolbar({
  snap,
  send,
  canRun,
  runHint,
  onRun,
  onSettings,
  onExport,
  confirmDiscard,
  splitCount,
  onSplit,
  knowledge,
  guided,
}: {
  snap: WorkspaceSnapshot | null;
  send: Send;
  canRun: boolean;
  /** Why Translate is unavailable, in a couple of words. */
  runHint: string | null;
  onRun: () => void;
  onSettings: () => void;
  onExport: () => void;
  confirmDiscard: (what: string) => boolean;
  /** Number of blocks the editor text would make, or null if unknown. */
  splitCount: number | null;
  onSplit: () => void;
  /** The knowledge base pane: whether it is showing, how many entries there are, and how many are waiting to be checked. */
  knowledge: { open: boolean; count: number; suggested: number; onToggle: () => void };
  /** Deep translate, the block-by-block way: whether its screen is showing. */
  guided: { open: boolean; onToggle: () => void };
}) {
  const project = snap?.project;
  const has = !!snap?.revision;
  const busy = snap?.busy ?? false;
  const c = snap ? countCells(snap) : null;
  const pct = c && c.total > 0 ? Math.round(((c.done + c.failed + c.canceled + c.review) / c.total) * 100) : 0;

  return (
    <Flex asChild align="center" justify="between" gap="3" px="3" py="2" className="toolbar">
      <header>
        <Flex align="center" gap="2" minWidth="0">
          <ProjectName title={project?.title ?? "Untitled"} path={project?.path ?? null} onRename={(title) => void send("project.rename", { title })} />
          {project?.dirty && (
            <Text color="amber" size="2" title="Unsaved changes" aria-label="Unsaved changes" role="img">
              ●
            </Text>
          )}
          {snap && snap.versions.length > 1 && (
            <Pick
              label="Version of the text"
              size="1"
              value={snap.viewingId ?? ""}
              onChange={(versionId) => void send("version.view", { versionId })}
              options={snap.versions.map((v) => ({ value: v.id, label: `Version ${v.number}${v.id === snap.latestId ? " (latest)" : ""}` }))}
            />
          )}
          {splitCount !== null && (
            <Button variant="ghost" size="1" onClick={onSplit} title="How the text will be split into blocks">
              {splitCount} {splitCount === 1 ? "block" : "blocks"}
            </Button>
          )}
        </Flex>

        <Flex align="center" gap="2" wrap="wrap" justify="end">
          {busy && c && (
            <span className="progress" role="img" aria-label={`${pct}% finished`} title={`${c.done} of ${c.total} done`}>
              <span className="progress-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
          {!busy && runHint && (
            <Text size="1" color="gray">
              {runHint}
            </Text>
          )}
          <Button variant={guided.open ? "soft" : "solid"} aria-pressed={guided.open} onClick={guided.onToggle} title="Translate one block at a time, checking the words, who is speaking and the result">
            Deep translate
          </Button>
          {busy ? (
            <Button color="red" variant="soft" onClick={() => void send("job.cancel", { kind: "job" })} title="Stop everything">
              ■ Stop
            </Button>
          ) : (
            <Button variant="outline" onClick={onRun} disabled={!canRun} title="Translate the whole text with every model (Ctrl/Cmd + Enter)">
              Translate
            </Button>
          )}
          <Button variant={knowledge.open ? "soft" : "outline"} color="gray" aria-pressed={knowledge.open} onClick={knowledge.onToggle} title="Show or hide the knowledge base">
            Knowledge base
            {knowledge.count > 0 && <Badge variant="soft">{knowledge.count}</Badge>}
            {knowledge.suggested > 0 && (
              <Badge color="amber" variant="soft">
                {knowledge.suggested} to check
              </Badge>
            )}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button variant="ghost" color="gray">
                File
                <DropdownMenu.TriggerIcon />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item disabled={busy || !!project?.recovery} onSelect={() => confirmDiscard("Opening another project") && void send("project.open", { useBackup: false })}>
                Open…
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!has} onSelect={() => void send("project.save", { saveAs: false })}>
                Save
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!has} onSelect={() => void send("project.save", { saveAs: true })}>
                Save as…
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!has} onSelect={onExport}>
                Export…
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item disabled={busy} onSelect={() => confirmDiscard("Starting a new project") && void send("project.new")}>
                New project
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <IconButton variant="ghost" color="gray" onClick={onSettings} aria-label="Settings" title="Settings">
            <GearIcon />
          </IconButton>
        </Flex>
      </header>
    </Flex>
  );
}
