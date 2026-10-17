import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";
import type { Word } from "@ltw/domain";
import { NameRow, type ClassInfo, type TopicRef, type WordActions } from "./NameRow";

/**
 * The words of the glossary found in the open text, in the knowledge base drawer: grouped by kind in the order of the classes file, in
 * the order they appear in the text, and narrowed by the search; the ignored ones apart, under their own heading.
 */
export function TextGlossary({
  words,
  classes,
  topics,
  kindLabel,
  firstAt,
  focus,
  actionsFor,
  onAdd,
}: {
  words: readonly Word[];
  classes: ClassInfo[];
  /** What a link can point to. */
  topics: TopicRef[];
  kindLabel: (kind: string) => string;
  /** Where a word first stands in the text, to list them in that order. */
  firstAt: (word: Word) => number;
  /** The word being looked at in the source. */
  focus: string | null;
  actionsFor: (word: Word) => WordActions;
  /** Adds a word from the text to the glossary. */
  onAdd: (source: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  // The words whose details are open. It belongs here, not to each row, so a word that moves to another group keeps its place.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (source: string) =>
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(source)) next.add(source);
      return next;
    });

  const q = filter.trim().toLocaleLowerCase();
  const shown = words.filter((n) => n.use !== false).filter((n) => q === "" || [n.source, n.english, kindLabel(n.kind), ...n.aliases].some((s) => s.toLocaleLowerCase().includes(q)));
  const kinds = [...new Set([...classes.map((c) => c.name), ...shown.map((n) => n.kind)])];
  const groups = kinds.map((kind) => ({ kind, names: shown.filter((n) => n.kind === kind).sort((a, b) => firstAt(a) - firstAt(b)) })).filter((g) => g.names.length > 0);
  const ignored = words.filter((n) => n.use === false);
  const row = (n: Word, open: boolean) => <NameRow key={n.source} name={n} classes={classes} topics={topics} expanded={open} focused={focus === n.source} onToggle={() => toggle(n.source)} actions={actionsFor(n)} />;

  return (
    <div className="text-glossary">
      <Text as="p" size="1" color="gray" mb="3">
        The names and terms of this text. In the text, a solid underline is a fixed English name and a dotted one a suggestion; rest the pointer on a word to see it, click it to change it.
      </Text>
      {words.length === 0 ? (
        <Text as="p" size="1" color="gray">
          Nothing from the glossary found in the text. Select a word in the text to add it, or add it below.
        </Text>
      ) : (
        <TextField.Root size="2" mb="2" type="search" aria-label="Search the glossary of the text" placeholder="Search this glossary" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
        </TextField.Root>
      )}
      {words.length > 0 && groups.length === 0 && (
        <Text as="p" size="1" color="gray">
          Nothing matches.
        </Text>
      )}
      {groups.map((g) => (
        <section key={g.kind} className="glossary-group">
          <Text as="div" size="1" weight="bold" color="gray" mt="3" mb="1" className="group-title">
            {kindLabel(g.kind)} · {g.names.length}
          </Text>
          <ul className="guided-glossary">{g.names.map((n) => row(n, opened.has(n.source)))}</ul>
        </section>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const word = newTerm.trim();
          if (word !== "") void onAdd(word).then((added) => added && setNewTerm(""));
        }}
      >
        <Flex gap="2" mt="2">
          <TextField.Root size="2" style={{ flex: 1 }} aria-label="Add a word from the text to the glossary" value={newTerm} placeholder="Add a word from the text" onChange={(e) => setNewTerm(e.target.value)} />
          <Button size="2" variant="soft" type="submit" disabled={newTerm.trim() === ""}>
            Add
          </Button>
        </Flex>
      </form>
      {ignored.length > 0 && (
        <section className="glossary-group">
          <Button variant="ghost" color="gray" size="1" mt="3" onClick={() => setShowIgnored((v) => !v)} aria-expanded={showIgnored}>
            {showIgnored ? <ChevronDownIcon /> : <ChevronRightIcon />} Ignored · {ignored.length}
          </Button>
          {showIgnored && <ul className="guided-glossary">{ignored.map((n) => row(n, false))}</ul>}
        </section>
      )}
    </div>
  );
}
