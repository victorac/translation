import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cross2Icon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { Badge, Box, Button, Checkbox, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import type { KnowledgeFiles as FileList } from "@ltw/domain";
import { api } from "./api";
import { Pick } from "./Pick";
import { TopicEditor, type Problem } from "./TopicEditor";

const KEY = "ltw.kbtabs.v1";

function loadTabs(): { open: string[]; active: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { open?: unknown; active?: unknown } | null;
    const open = Array.isArray(raw?.open) ? raw!.open.filter((x): x is string => typeof x === "string") : [];
    return { open, active: typeof raw?.active === "string" ? raw.active : null };
  } catch {
    return { open: [], active: null };
  }
}

/**
 * The knowledge base as files: a list of topics (and scenes, summaries, notes and classes) you can search, open in tabs
 * and edit as text. Links between files can be followed, and each file shows what links to it.
 */
export function KnowledgeFiles({ rev, counts, openRequest, compact }: { rev: number; counts: { terms: number; notes: number; suggested: number }; openRequest?: { id: string; n: number } | null; compact?: boolean }) {
  const [list, setList] = useState<FileList | null>(null);
  const [tabs, setTabs] = useState(loadTabs);
  const [query, setQuery] = useState("");
  const [onlyChecking, setOnlyChecking] = useState(false);
  const [listOpen, setListOpen] = useState(!compact);
  const [creating, setCreating] = useState<{ type: string; name: string } | null>(null);
  const [loaded, setLoaded] = useState<{ title: string; problems: Problem[]; backlinks: { id: string; title: string }[] } | null>(null);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const resolving = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    void api.invoke("knowledge.files").then((r) => live && r.ok && setList(r.value));
    return () => {
      live = false;
    };
  }, [rev]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(tabs));
    } catch {
      /* the open tabs then last for this session only */
    }
  }, [tabs]);

  // Another part of the app asks for a topic to be opened (n changes each time, so the same topic can be asked for again).
  useEffect(() => {
    if (openRequest) setTabs((t) => ({ open: t.open.includes(openRequest.id) ? t.open : [...t.open, openRequest.id], active: openRequest.id }));
  }, [openRequest?.id, openRequest?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = list?.files ?? [];
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  // Tabs for files that no longer exist are dropped once the list is known.
  const open = list ? tabs.open.filter((id) => byId.has(id)) : tabs.open;
  const active = tabs.active && open.includes(tabs.active) ? tabs.active : (open[0] ?? null);

  const openFile = useCallback((id: string) => setTabs((t) => ({ open: t.open.includes(id) ? t.open : [...t.open, id], active: id })), []);
  const closeFile = (id: string) =>
    setTabs((t) => {
      const next = t.open.filter((x) => x !== id);
      return { open: next, active: t.active === id ? (next[next.indexOf(id) - 1] ?? next[0] ?? null) : t.active };
    });

  const q = query.trim().toLocaleLowerCase();
  const shown = files.filter((f) => (!onlyChecking || f.suggested) && (q === "" || `${f.title} ${f.subtitle}`.toLocaleLowerCase().includes(q)));
  const groups = [...new Set(shown.map((f) => f.groupLabel))].map((label) => ({ label, files: shown.filter((f) => f.groupLabel === label) }));

  // The links in the file being edited, and which of them lead somewhere.
  const links = useMemo(() => [...new Set([...typed.matchAll(/\[\[(.*?)\]\]/g)].map((m) => m[1]!.trim()).filter(Boolean))], [typed]);
  useEffect(() => {
    resolving.current.clear();
    setResolved({});
  }, [rev]);
  useEffect(() => {
    for (const name of links) {
      if (resolving.current.has(name)) continue;
      resolving.current.add(name);
      void api.invoke("knowledge.resolve", { name }).then((r) => r.ok && setResolved((x) => ({ ...x, [name]: r.value.id })));
    }
  }, [links, rev]);

  const follow = async (name: string, key = "") => {
    const r = await api.invoke("knowledge.resolve", { name });
    if (r.ok && r.value.id) return openFile(r.value.id);
    // No topic of that name yet: offer to make one, as the kind the attribute points to when that is known.
    const type = list?.classes.find((c) => c.name === key)?.name ?? "term";
    if (window.confirm(`There is no topic called "${name}". Create it?`)) {
      const made = await api.invoke("knowledge.create", { type, name });
      if (made.ok) openFile(made.value.id);
      else setMessage(made.error.message);
    }
  };

  const create = async () => {
    if (!creating || creating.name.trim() === "") return;
    const r = await api.invoke("knowledge.create", { type: creating.type, name: creating.name.trim() });
    if (!r.ok) return setMessage(r.error.message);
    setCreating(null);
    openFile(r.value.id);
  };

  const deletable = active && byId.get(active) && ["topic", "scene", "summary"].includes(byId.get(active)!.kind);

  return (
    <Flex direction="column" className="kbf">
      <Flex align="center" justify="between" gap="2" px="3" py="2" wrap="wrap" className="kbf-bar">
        <Text size="1" color="gray">
          {counts.terms} {counts.terms === 1 ? "topic" : "topics"}
          {counts.suggested > 0 && ` · ${counts.suggested} to check`}
        </Text>
        <Flex gap="2">
          {counts.suggested > 0 && (
            <Button size="1" variant="soft" onClick={() => void api.invoke("knowledge.confirm", {})} title="Accept everything the app suggested">
              Accept all
            </Button>
          )}
          <Button size="1" variant="soft" color="gray" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
            {listOpen ? "Hide files" : "Files"}
          </Button>
          <Button size="1" onClick={() => setCreating(creating ? null : { type: list?.classes[0]?.name ?? "character", name: "" })}>
            New topic
          </Button>
        </Flex>
      </Flex>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Flex gap="2" px="3" pb="2" align="center" wrap="wrap">
            <Pick size="1" label="Kind of topic" value={creating.type} options={(list?.classes ?? []).map((c) => ({ value: c.name, label: c.name[0]?.toLocaleUpperCase() + c.name.slice(1) }))} onChange={(type) => setCreating({ ...creating, type })} />
            <TextField.Root size="1" style={{ flex: 1, minWidth: "8rem" }} autoFocus placeholder="Name as written in the text" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            <Button size="1" type="submit" disabled={creating.name.trim() === ""}>
              Create
            </Button>
            <Button size="1" type="button" variant="soft" color="gray" onClick={() => setCreating(null)}>
              Cancel
            </Button>
          </Flex>
        </form>
      )}
      {message && (
        <Text as="p" size="1" color="gray" mx="3" role="status">
          {message}
        </Text>
      )}

      {listOpen && (
        <Box px="3" pb="2" className="kbf-list">
          <Flex gap="3" align="center" mb="2">
            <TextField.Root size="1" style={{ flex: 1 }} type="search" aria-label="Search the files" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)}>
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
            {counts.suggested > 0 && (
              <Text as="label" size="1">
                <Flex gap="1" align="center">
                  <Checkbox size="1" checked={onlyChecking} onCheckedChange={(c) => setOnlyChecking(c === true)} />
                  To check
                </Flex>
              </Text>
            )}
          </Flex>
          {groups.map((g) => (
            <section key={g.label}>
              <Text as="div" size="1" weight="bold" color="gray" mt="2" mb="1">
                {g.label} · {g.files.length}
              </Text>
              <ul className="plain-list">
                {g.files.map((f) => (
                  <li key={f.id}>
                    <Button variant={f.id === active ? "soft" : "ghost"} color={f.id === active ? "indigo" : "gray"} size="1" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => openFile(f.id)} title={f.subtitle}>
                      <Text truncate>{f.title}</Text>
                      {f.subtitle && f.kind === "topic" && (
                        <Text size="1" color="gray" truncate>
                          {f.subtitle}
                        </Text>
                      )}
                      {f.suggested && <Badge color="amber" variant="soft" size="1">to check</Badge>}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {list && groups.length === 0 && (
            <Text as="p" size="1" color="gray">
              Nothing matches.
            </Text>
          )}
        </Box>
      )}

      {open.length > 0 && (
        <Flex gap="1" px="3" wrap="wrap" role="tablist" className="kbf-tabs">
          {open.map((id) => (
            <Flex key={id} align="center" className="kbf-tab">
              <Button role="tab" aria-selected={id === active} variant={id === active ? "soft" : "ghost"} color={id === active ? "indigo" : "gray"} size="1" onClick={() => setTabs((t) => ({ ...t, active: id }))}>
                {byId.get(id)?.title ?? "…"}
                {byId.get(id)?.suggested && (
                  <Text color="amber" weight="bold">
                    ?
                  </Text>
                )}
              </Button>
              <IconButton variant="ghost" color="gray" size="1" aria-label={`Close ${byId.get(id)?.title ?? "file"}`} onClick={() => closeFile(id)}>
                <Cross2Icon />
              </IconButton>
            </Flex>
          ))}
        </Flex>
      )}

      {active ? (
        <>
          <TopicEditor key={active} id={active} rev={rev} onLink={(name, key) => void follow(name, key)} onLoaded={(f) => setLoaded({ title: f.title, problems: f.problems, backlinks: f.backlinks })} onText={setTyped} />
          <Flex direction="column" gap="2" p="3" className="kbf-foot">
            {loaded && loaded.problems.length > 0 && (
              <Text size="1" color="red">
                {loaded.problems.length} to fix
              </Text>
            )}
            {links.length > 0 && (
              <Flex gap="1" wrap="wrap" align="center">
                <Text size="1" color="gray">
                  Links:
                </Text>
                {links.map((name) => (
                  <Button key={name} size="1" variant="soft" color={resolved[name] ? "indigo" : "amber"} title={resolved[name] ? "Open" : "No topic of that name yet. Click to create it."} onClick={() => void follow(name)}>
                    {name}
                  </Button>
                ))}
              </Flex>
            )}
            {loaded && loaded.backlinks.length > 0 && (
              <Flex gap="1" wrap="wrap" align="center">
                <Text size="1" color="gray">
                  Linked from:
                </Text>
                {loaded.backlinks.map((b) => (
                  <Button key={b.id} size="1" variant="soft" onClick={() => openFile(b.id)}>
                    {b.title}
                  </Button>
                ))}
              </Flex>
            )}
            <Flex gap="2">
              {byId.get(active)?.suggested && (
                <Button size="2" style={{ flex: 1 }} onClick={() => void api.invoke("knowledge.confirm", { ids: [active] })} title="Accept what the app suggested in this file: the topic, its attributes and its notes">
                  Accept this file
                </Button>
              )}
              {deletable && (
                <Button
                  size="2"
                  variant="soft"
                  color={byId.get(active)?.suggested ? "red" : "gray"}
                  style={{ flex: 1 }}
                  onClick={() => {
                    const f = byId.get(active)!;
                    if (window.confirm(f.suggested ? `Reject "${f.title}"? It will not be suggested again.` : `Delete "${f.title}"?`)) {
                      closeFile(active);
                      void api.invoke("knowledge.delete", { id: active });
                    }
                  }}
                >
                  {byId.get(active)?.suggested ? "Reject this file" : "Delete this file"}
                </Button>
              )}
            </Flex>
          </Flex>
        </>
      ) : (
        <Text as="p" size="2" color="gray" m="3">
          {files.length <= 1 ? "No topics yet. Make one with New topic, or use a word in the workspace and it is added when you translate." : "Open a file from the list."}
        </Text>
      )}
    </Flex>
  );
}
