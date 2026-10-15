import { useEffect, useMemo, useRef, useState } from "react";
import { Cross2Icon, MagnifyingGlassIcon, PlusIcon } from "@radix-ui/react-icons";
import { Badge, Button, Checkbox, Flex, Heading, IconButton, Text, TextField } from "@radix-ui/themes";
import type { KnowledgeEntry, KnowledgeFiles as FileList } from "@ltw/domain";
import { api } from "./api";
import { Details, TextBox, type ClassInfo, type TopicRef } from "./NameRow";
import { Pick } from "./Pick";
import { useToast } from "./Toast";
import { TopicEditor, type Problem } from "./TopicEditor";

const ALL_KINDS = "";
const WIDTH_KEY = "ltw.drawer.width.v1";
const MIN_WIDTH = 560;
/** How far the drawer stops from the left edge of the window at its widest, and how far a key press moves its edge. */
const EDGE_GAP = 48;
const KEY_STEP = 32;

const loadWidth = (): number => {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(v) && v >= MIN_WIDTH) return v;
  } catch {
    /* the width is then kept for this session only */
  }
  return Math.min(1024, Math.round(window.innerWidth * 0.94));
};

/**
 * The knowledge base, as a drawer over the workspace: a list of the topics (searchable, by kind, with checkboxes to act on several)
 * and, for the one chosen, the same details form as in the reading pane, or its file as text. The classes file, which says what kinds of
 * topic there are, is opened from the header, not listed among the topics.
 */
export function KnowledgeDrawer({
  open,
  request,
  rev,
  counts,
  onClose,
}: {
  open: boolean;
  /** A topic another part of the app asks to show (`n` changes each time, so the same topic can be asked for again). */
  request: { id: string; n: number } | null;
  rev: number;
  counts: { terms: number; notes: number; suggested: number };
  onClose: () => void;
}) {
  const toast = useToast();
  const widest = () => Math.max(MIN_WIDTH, window.innerWidth - EDGE_GAP);
  const keepWidth = (w: number) => {
    const next = Math.round(Math.min(Math.max(w, MIN_WIDTH), widest()));
    setWidth(next);
    return next;
  };
  const saveWidth = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* kept for this session only */
    }
  };
  const [list, setList] = useState<FileList | null>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState(ALL_KINDS);
  const [onlyChecking, setOnlyChecking] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const [creating, setCreating] = useState<{ type: string; name: string; english: string; hint: string } | null>(null);
  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ problems: Problem[]; backlinks: { id: string; title: string }[] } | null>(null);
  const [typed, setTyped] = useState("");
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const resolving = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api.invoke("knowledge.files").then((r) => live && r.ok && setList(r.value));
    void api.invoke("knowledge.list", { kind: "term" }).then((r) => live && r.ok && setEntries(r.value.entries));
    return () => {
      live = false;
    };
  }, [rev, open]);

  // Escape closes the drawer, after a menu or a dropdown that is open (they take the key first and mark it as used) and after a new topic being written.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (creating) setCreating(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, creating, onClose]);

  useEffect(() => {
    if (request) {
      setActive(request.id);
      setAsText(false);
    }
  }, [request?.id, request?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const classes: ClassInfo[] = list?.classes ?? [];
  const files = (list?.files ?? []).filter((f) => f.kind !== "classes");
  const byId = useMemo(() => new Map((list?.files ?? []).map((f) => [f.id, f])), [list]);
  const entryOf = (id: string) => entries.find((e) => e.id === id);
  const file = active ? byId.get(active) : undefined;
  const entry = active ? entryOf(active) : undefined;
  const topics: TopicRef[] = entries.map((e) => ({ source: e.source, english: e.target, category: e.category }));
  const kindLabel = (name: string) => classes.find((c) => c.name === name)?.label ?? name;

  // A topic that was deleted is no longer the one shown.
  useEffect(() => {
    if (list && active && !byId.has(active)) setActive(null);
    setChecked((c) => new Set([...c].filter((id) => byId.has(id))));
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLocaleLowerCase();
  const shown = files.filter((f) => {
    if (onlyChecking && !f.suggested) return false;
    if (kindFilter !== ALL_KINDS && !(f.kind === "topic" && entryOf(f.id)?.category === kindFilter)) return false;
    return q === "" || `${f.title} ${f.subtitle}`.toLocaleLowerCase().includes(q);
  });
  const groups = [...new Set(shown.map((f) => f.groupLabel))].map((label) => ({ label, files: shown.filter((f) => f.groupLabel === label) }));

  // The file of the topic shown: what links to it, and in text form the problems and links of what is typed.
  useEffect(() => {
    setLoaded(null);
    setTyped("");
    if (!active || asText) return;
    let live = true;
    void api.invoke("knowledge.file", { id: active }).then((r) => live && r.ok && setLoaded({ problems: r.value.problems, backlinks: r.value.backlinks }));
    return () => {
      live = false;
    };
  }, [active, asText, rev]);
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

  const show = (id: string) => {
    setCreating(null);
    setActive(id);
    setAsText(false);
  };

  const follow = async (name: string) => {
    const r = await api.invoke("knowledge.resolve", { name });
    if (r.ok && r.value.id) return show(r.value.id);
    const made = await api.invoke("knowledge.create", { type: "term", name });
    if (made.ok) show(made.value.id);
    else setMessage(made.error.message);
  };

  const create = async () => {
    if (!creating || creating.name.trim() === "") return;
    const r = await api.invoke("knowledge.create", { type: creating.type, name: creating.name.trim(), english: creating.english, hint: creating.hint });
    if (!r.ok) return setMessage(r.error.message);
    setMessage(null);
    show(r.value.id);
  };

  const edit = async (id: string, change: { target?: string; hint?: string; kind?: string; attribute?: { key: string; values: string[] } }) => {
    const r = await api.invoke("knowledge.edit", { id, ...change });
    setMessage(r.ok ? null : r.error.message);
  };

  const remove = async (ids: string[]) => {
    const names = ids.map((id) => byId.get(id)?.title ?? "").filter((t) => t !== "");
    const r = await api.invoke("knowledge.deleteMany", { ids });
    if (!r.ok) return setMessage(r.error.message);
    setChecked(new Set());
    if (active && ids.includes(active)) setActive(null);
    toast({
      text: names.length === 1 ? `Deleted ${names[0]}.` : `Deleted ${r.value.removed} topics.`,
      action: { label: "Undo", run: () => void api.invoke("work.undoRemove").then((u) => !u.ok && toast({ text: u.error.message })) },
    });
  };

  const confirmIds = (ids: string[]) => void api.invoke("knowledge.confirm", { ids });
  const toCheck = [...checked].filter((id) => byId.get(id)?.suggested);

  if (!open) return null;
  const isTopic = file?.kind === "topic" && entry !== undefined;

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Knowledge base" ref={panel} tabIndex={-1} style={{ width: Math.min(width, widest()) }}>
        <div
          className="drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the knowledge base"
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
          }}
          onPointerMove={(e) => dragging.current && keepWidth(window.innerWidth - e.clientX)}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            saveWidth(keepWidth(window.innerWidth - e.clientX));
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            saveWidth(keepWidth(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP)));
          }}
        />
        <Flex align="center" justify="between" gap="3" px="4" py="3" className="drawer-head">
          <Flex align="baseline" gap="2">
            <Heading as="h2" size="4">
              Knowledge base
            </Heading>
            <Text size="1" color="gray">
              {counts.terms} {counts.terms === 1 ? "topic" : "topics"}
              {counts.suggested > 0 && ` · ${counts.suggested} to check`}
            </Text>
          </Flex>
          <Flex align="center" gap="2">
            {counts.suggested > 0 && (
              <Button size="1" variant="soft" onClick={() => confirmIds(files.filter((f) => f.suggested).map((f) => f.id))} title="Confirm every topic that is still only suggested">
                Confirm all to check
              </Button>
            )}
            <Button
              size="1"
              variant={active === "classes" ? "soft" : "ghost"}
              color="gray"
              onClick={() => {
                setActive("classes");
                setAsText(true);
              }}
              title="Which kinds of topic there are, and the attributes each has"
            >
              Kinds of topic
            </Button>
            <IconButton variant="ghost" color="gray" size="2" onClick={onClose} aria-label="Close the knowledge base">
              <Cross2Icon />
            </IconButton>
          </Flex>
        </Flex>

        <div className="drawer-body">
          <Flex direction="column" className="drawer-list">
            <Flex direction="column" gap="2" p="3">
              <Flex gap="2">
                <TextField.Root size="2" style={{ flex: 1 }} type="search" aria-label="Search the topics" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)}>
                  <TextField.Slot>
                    <MagnifyingGlassIcon />
                  </TextField.Slot>
                </TextField.Root>
                <Button size="2" onClick={() => {
                    setMessage(null);
                    setActive(null);
                    setCreating(creating ? null : { type: classes[0]?.name ?? "character", name: "", english: "", hint: "" });
                  }}
                  aria-pressed={creating !== null}
                >
                  <PlusIcon /> New
                </Button>
              </Flex>
              <Flex gap="3" align="center">
                <Pick size="1" label="Show only this kind" value={kindFilter} options={[{ value: ALL_KINDS, label: "All kinds" }, ...classes.map((c) => ({ value: c.name, label: c.label }))]} onChange={setKindFilter} />
                {counts.suggested > 0 && (
                  <Text as="label" size="1">
                    <Flex gap="1" align="center">
                      <Checkbox size="1" checked={onlyChecking} onCheckedChange={(c) => setOnlyChecking(c === true)} />
                      To check
                    </Flex>
                  </Text>
                )}
              </Flex>
              {message && (
                <Text as="p" size="1" color="red" role="status">
                  {message}
                </Text>
              )}
            </Flex>

            {checked.size > 0 && (
              <Flex align="center" justify="between" gap="2" px="3" py="2" className="drawer-bulk">
                <Text size="2" weight="medium">
                  {checked.size} selected
                </Text>
                <Flex gap="2">
                  {toCheck.length > 0 && (
                    <Button size="1" variant="soft" onClick={() => confirmIds(toCheck)}>
                      Confirm
                    </Button>
                  )}
                  <Button size="1" variant="soft" color="red" onClick={() => void remove([...checked])}>
                    Delete
                  </Button>
                  <Button size="1" variant="ghost" color="gray" onClick={() => setChecked(new Set())}>
                    Clear
                  </Button>
                </Flex>
              </Flex>
            )}

            <div className="drawer-scroll">
              {groups.map((g) => (
                <section key={g.label}>
                  <Text as="div" size="1" weight="bold" color="gray" mt="2" mb="1" ml="3">
                    {g.label} · {g.files.length}
                  </Text>
                  <ul className="plain-list">
                    {g.files.map((f) => (
                      <li key={f.id} className={f.id === active ? "drawer-row drawer-row-active" : "drawer-row"}>
                        <Checkbox size="1" checked={checked.has(f.id)} onCheckedChange={(c) => setChecked((s) => (c === true ? new Set([...s, f.id]) : new Set([...s].filter((x) => x !== f.id))))} aria-label={`Select ${f.title}`} />
                        <button type="button" className="drawer-row-main" onClick={() => show(f.id)} title={f.subtitle}>
                          <Text size="2" weight={f.id === active ? "bold" : "regular"} truncate>
                            {f.title}
                          </Text>
                          {f.subtitle && f.kind === "topic" && (
                            <Text size="1" color="gray" truncate>
                              {f.subtitle}
                            </Text>
                          )}
                        </button>
                        {f.suggested && (
                          <Badge color="amber" variant="soft" size="1">
                            to check
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {list && groups.length === 0 && (
                <Text as="p" size="2" color="gray" m="3">
                  {files.length === 0 ? "No topics yet. Select a word in the text to add it, or use New." : "Nothing matches."}
                </Text>
              )}
            </div>
          </Flex>

          <Flex direction="column" className="drawer-detail">
            {creating ? (
              <form
                className="drawer-scroll"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <Flex direction="column" gap="3" p="4">
                  <Heading as="h3" size="4">
                    New topic
                  </Heading>
                  <Text size="2" color="gray">
                    Write the name as it is in the text, then how it is written in English, or a note for the model, or both. Nothing is saved until you press Create.
                  </Text>
                  <label>
                    <Text as="div" size="2" weight="medium" mb="1">
                      Name in the text
                    </Text>
                    <TextField.Root autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} aria-label="Name in the text" />
                  </label>
                  <div>
                    <Text as="div" size="2" weight="medium" mb="1">
                      Kind
                    </Text>
                    <Pick label="Kind of the new topic" value={creating.type} options={classes.map((c) => ({ value: c.name, label: c.label }))} onChange={(type) => setCreating({ ...creating, type })} />
                  </div>
                  <label>
                    <Text as="div" size="2" weight="medium" mb="1">
                      English name
                    </Text>
                    <TextField.Root value={creating.english} onChange={(e) => setCreating({ ...creating, english: e.target.value })} placeholder="The model must write it exactly like this" aria-label="English name" />
                  </label>
                  <label>
                    <Text as="div" size="2" weight="medium" mb="1">
                      Note to the model
                    </Text>
                    <TextField.Root value={creating.hint} onChange={(e) => setCreating({ ...creating, hint: e.target.value })} placeholder="A hint, such as who it is or how to write it; it is a suggestion, not forced" aria-label="Note to the model" />
                  </label>
                  {message && (
                    <Text as="p" size="1" color="red" role="status">
                      {message}
                    </Text>
                  )}
                  <Flex gap="2">
                    <Button type="submit" disabled={creating.name.trim() === "" || (creating.english.trim() === "" && creating.hint.trim() === "")}>
                      Create
                    </Button>
                    <Button type="button" variant="soft" color="gray" onClick={() => setCreating(null)}>
                      Cancel
                    </Button>
                  </Flex>
                </Flex>
              </form>
            ) : !file && active !== "classes" ? (
              <Text as="p" size="2" color="gray" m="4">
                Choose a topic from the list.
              </Text>
            ) : isTopic && !asText ? (
              <div className="drawer-scroll">
                <Flex direction="column" gap="3" p="4">
                  <Flex align="center" justify="between" gap="2" wrap="wrap">
                    <Flex align="center" gap="2">
                      <Heading as="h3" size="4">
                        {entry.source}
                      </Heading>
                      {file!.suggested && (
                        <Badge color="amber" variant="soft">
                          to check
                        </Badge>
                      )}
                    </Flex>
                    <Flex gap="2">
                      {file!.suggested && (
                        <Button size="1" onClick={() => confirmIds([entry.id])} title="Accept what the app suggested: the topic, its attributes and its notes">
                          Confirm
                        </Button>
                      )}
                      <Button size="1" variant="soft" color="gray" onClick={() => setAsText(true)} title="See the file as text, with every detail">
                        Edit as text
                      </Button>
                      <Button size="1" variant="soft" color="red" onClick={() => void remove([entry.id])}>
                        {file!.suggested ? "Reject" : "Delete"}
                      </Button>
                    </Flex>
                  </Flex>
                  <Flex align="center" gap="3">
                    <Text size="2" color="gray" style={{ width: "5.5rem" }}>
                      English
                    </Text>
                    <div style={{ flex: 1 }}>
                      <TextBox value={entry.target} label={`English name of ${entry.source}`} placeholder="How it is written in the translation" onSave={(v) => void edit(entry.id, { target: v })} />
                    </div>
                  </Flex>
                  <Details
                    key={entry.id}
                    subject={{ source: entry.source, kind: entry.category, hint: entry.hint, attrs: entry.attrs, suggestions: {} }}
                    classes={classes}
                    topics={topics}
                    onKind={(kind) => void edit(entry.id, { kind })}
                    onHint={(hint) => void edit(entry.id, { hint })}
                    onAttribute={(key, values) => void edit(entry.id, { attribute: { key, values } })}
                  />
                  {entry.aliases.length > 0 && (
                    <Flex gap="1" wrap="wrap" align="center">
                      <Text size="1" color="gray">
                        Also written:
                      </Text>
                      {entry.aliases.map((a) => (
                        <Badge key={a} variant="soft" color="gray">
                          {a}
                        </Badge>
                      ))}
                    </Flex>
                  )}
                  {loaded && loaded.backlinks.length > 0 && (
                    <Flex gap="1" wrap="wrap" align="center">
                      <Text size="1" color="gray">
                        Linked from:
                      </Text>
                      {loaded.backlinks.map((b) => (
                        <Button key={b.id} size="1" variant="soft" onClick={() => show(b.id)}>
                          {b.title}
                        </Button>
                      ))}
                    </Flex>
                  )}
                </Flex>
              </div>
            ) : (
              active && (
                <>
                  <Flex align="center" justify="between" gap="2" px="4" py="2" className="drawer-detail-bar">
                    <Text size="2" weight="bold" truncate>
                      {active === "classes" ? "Kinds of topic" : (file?.title ?? "")}
                    </Text>
                    <Flex gap="2">
                      {isTopic && (
                        <Button size="1" variant="soft" color="gray" onClick={() => setAsText(false)}>
                          Back to the form
                        </Button>
                      )}
                      {file && ["scene", "summary", "topic"].includes(file.kind) && (
                        <Button size="1" variant="soft" color="red" onClick={() => void remove([active])}>
                          Delete
                        </Button>
                      )}
                    </Flex>
                  </Flex>
                  <TopicEditor key={active} id={active} rev={rev} onLink={(name) => void follow(name)} onLoaded={(f) => setLoaded({ problems: f.problems, backlinks: f.backlinks })} onText={setTyped} />
                  <Flex direction="column" gap="2" p="3">
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
                          <Button key={b.id} size="1" variant="soft" onClick={() => show(b.id)}>
                            {b.title}
                          </Button>
                        ))}
                      </Flex>
                    )}
                  </Flex>
                </>
              )
            )}
          </Flex>
        </div>
      </aside>
    </div>
  );
}
