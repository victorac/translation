import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, Cross2Icon, DotsHorizontalIcon } from "@radix-ui/react-icons";
import { Badge, Button, DropdownMenu, Flex, IconButton, Text, TextField } from "@radix-ui/themes";
import type { AttributeDef, Word } from "@ltw/domain";
import { Pick } from "./Pick";

export interface ClassInfo {
  name: string;
  label: string;
  attributes: AttributeDef[];
}

export interface TopicRef {
  source: string;
  english: string;
  category: string;
}

const KIND_LABEL: Record<string, string> = { character: "person", family: "family", place: "place", organization: "organization", term: "term" };

/** A text field that keeps what is being typed and saves it when the field is left (Enter saves, Escape goes back). */
function TextBox({ value, label, placeholder, onSave, onEmptyEnter, onEmptyEscape, className }: { value: string; label: string; placeholder?: string; onSave: (value: string) => void; onEmptyEnter?: () => void; onEmptyEscape?: () => void; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <TextField.Root
      size="1"
      {...(className !== undefined ? { className } : {})}
      aria-label={label}
      value={text}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value.trim() && onSave(text)}
      onKeyDown={(e) => {
        const empty = text.trim() === "" && value.trim() === "";
        if (e.key === "Enter") {
          if (empty && onEmptyEnter) onEmptyEnter();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          if (empty && onEmptyEscape) onEmptyEscape();
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A value that is only suggested (by the dictionary, or by the model from the translation): marked as such, to use or to drop. */
function Suggested({ text, onUse, onDismiss }: { text: string; onUse: () => void; onDismiss: () => void }) {
  return (
    <Flex align="center" gap="1" className="suggested">
      <Badge size="1" variant="soft" color="amber">
        suggested
      </Badge>
      <Text size="1" color="gray" truncate>
        {text}
      </Text>
      <Button variant="ghost" size="1" onClick={onUse} title="Confirm this value: it becomes the value, as if you had written it">
        <CheckIcon /> Confirm
      </Button>
      <IconButton variant="ghost" size="1" color="gray" onClick={onDismiss} aria-label="Drop this suggestion" title="Drop this suggestion">
        <Cross2Icon />
      </IconButton>
    </Flex>
  );
}

/**
 * One word of the text, on one line: the word (click it to see where it stands in the text), its English name, which is written right
 * there (a suggestion shows in grey, Enter accepts it and Escape drops it), and a menu. The arrow opens the details: the type, a note,
 * and the attributes that have a value; the others are added from "Add detail".
 */
export function NameRow({
  name,
  classes,
  topics,
  expanded,
  focused,
  onToggle,
  onLocate,
  onUse,
  onOpen,
  onRemove,
  onEnglish,
  onHint,
  onKind,
  onAttribute,
  onAcceptSuggestion,
  onDismissSuggestion,
}: {
  name: Word;
  classes: ClassInfo[];
  topics: TopicRef[];
  expanded: boolean;
  focused: boolean;
  /** The arrow was clicked: the details open or close. */
  onToggle: () => void;
  /** The word was clicked: it is shown in the source. */
  onLocate: () => void;
  onUse: (use: boolean) => void;
  onOpen: () => void;
  onRemove: () => void;
  onEnglish: (english: string) => void;
  onHint: (hint: string) => void;
  onKind: (kind: string) => void;
  onAttribute: (key: string, values: string[]) => void;
  onAcceptSuggestion: (key: string) => void;
  onDismissSuggestion: (key: string) => void;
}) {
  const def = classes.find((c) => c.name === name.kind);
  const attrs = name.attrs ?? {};
  const suggestions = name.suggestions ?? {};
  const suggestedEnglish = name.english.trim() === "" ? (suggestions["english"]?.[0] ?? "") : "";
  const used = name.use !== false;
  const shown = (t: TopicRef) => (t.english.trim() !== "" ? `${t.english.trim()} (${t.source})` : t.source);
  const poolFor = (a: AttributeDef) => topics.filter((t) => t.source !== name.source && (!a.target || t.category === a.target));
  // The attributes with a value (or a suggestion) show; the user adds the others one at a time.
  const [added, setAdded] = useState<string[]>([]);
  const hasValue = (a: AttributeDef) => (attrs[a.key] ?? []).length > 0 || (suggestions[a.key] ?? []).length > 0 || added.includes(a.key);
  const attributes = def?.attributes ?? [];
  const hidden = attributes.filter((a) => !hasValue(a));

  const kindOptions = classes.length === 0 ? [{ value: name.kind, label: KIND_LABEL[name.kind] ?? name.kind }] : classes.map((c) => ({ value: c.name, label: KIND_LABEL[c.name] ?? c.name }));

  return (
    <li className={used ? "name-item" : "name-item ignored"}>
      <Flex align="center" gap="1" className="glossary-head">
        <IconButton variant="ghost" size="1" color="gray" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} the details of ${name.source}`} title="Details">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </IconButton>
        <Button variant={focused ? "soft" : "ghost"} color={focused ? "indigo" : "gray"} size="1" onClick={onLocate} aria-pressed={focused} title="Show where it appears in the text" className="glossary-source">
          <Text weight="bold" size="2" truncate>
            {name.source}
          </Text>
        </Button>
        {used ? (
          <Flex align="center" gap="1" className="name-english">
            <TextBox
              className={suggestedEnglish !== "" ? "english-suggested" : name.english.trim() === "" && !name.hint ? "english-missing" : ""}
              value={name.english}
              label={`English name of ${name.source}`}
              placeholder={suggestedEnglish !== "" ? suggestedEnglish : name.hint ? `note: ${name.hint}` : "English name"}
              onSave={onEnglish}
              onEmptyEnter={() => suggestedEnglish !== "" && onAcceptSuggestion("english")}
              onEmptyEscape={() => suggestedEnglish !== "" && onDismissSuggestion("english")}
            />
            {suggestedEnglish !== "" && (
              <IconButton variant="ghost" size="1" onClick={() => onAcceptSuggestion("english")} aria-label={`Confirm ${suggestedEnglish} as the English name of ${name.source}`} title="Suggested, not confirmed. Click or press Enter to confirm, Escape to drop it.">
                <CheckIcon />
              </IconButton>
            )}
          </Flex>
        ) : (
          <Text size="2" color="gray" className="name-english" truncate>
            ignored in this text
          </Text>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton variant="ghost" size="1" color="gray" aria-label={`More about ${name.source}`}>
              <DotsHorizontalIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content size="1" align="end">
            <DropdownMenu.Item onSelect={() => onUse(!used)}>{used ? "Ignore in this text" : "Use in this text"}</DropdownMenu.Item>
            {!name.draft && <DropdownMenu.Item onSelect={onOpen}>Open in the knowledge base</DropdownMenu.Item>}
            <DropdownMenu.Separator />
            <DropdownMenu.Item color="red" onSelect={onRemove}>
              Remove from the glossary
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
      {expanded && (
        <ul className="tree" aria-label={`Details of ${name.source}`}>
          <li>
            <Text size="1" color="gray">type</Text>
            <Pick size="1" label={`Type of ${name.source}`} value={name.kind} options={kindOptions} onChange={onKind} />
          </li>
          <li>
            <Text size="1" color="gray">note</Text>
            <TextBox value={name.hint ?? ""} label={`Note to the model about ${name.source}`} placeholder="A hint for the model (the English name can stay empty)" onSave={onHint} />
          </li>
          {attributes.filter(hasValue).map((a) => {
            const chosen = attrs[a.key] ?? [];
            const key = <Text size="1" color="gray">{a.key}</Text>;
            if (a.kind === "text")
              return (
                <li key={a.key}>
                  {key}
                  <TextBox value={chosen.join(", ")} label={`${a.key} of ${name.source}`} onSave={(v) => onAttribute(a.key, v.trim() === "" ? [] : [v.trim()])} />
                </li>
              );
            if (a.kind === "choice")
              return (
                <li key={a.key}>
                  {key}
                  <div className="tree-field">
                    <Pick size="1" label={`${a.key} of ${name.source}`} value={chosen[0] ?? ""} options={[{ value: "", label: "not set" }, ...(a.choices ?? []).map((c) => ({ value: c, label: c }))]} onChange={(v) => onAttribute(a.key, v === "" ? [] : [v])} />
                    {chosen.length === 0 && suggestions[a.key]?.[0] && <Suggested text={suggestions[a.key]![0]!} onUse={() => onAcceptSuggestion(a.key)} onDismiss={() => onDismissSuggestion(a.key)} />}
                  </div>
                </li>
              );
            const pool = poolFor(a);
            if (a.kind === "link")
              return (
                <li key={a.key}>
                  {key}
                  <Pick
                    size="1"
                    label={`${a.key} of ${name.source}`}
                    value={chosen[0] ?? ""}
                    disabled={pool.length === 0 && chosen.length === 0}
                    options={[
                      { value: "", label: pool.length === 0 && chosen.length === 0 ? `no ${a.target ?? "topic"} yet` : "not set" },
                      ...(chosen[0] && !pool.some((t) => t.source === chosen[0]) ? [{ value: chosen[0], label: chosen[0] }] : []),
                      ...pool.map((t) => ({ value: t.source, label: shown(t) })),
                    ]}
                    onChange={(v) => onAttribute(a.key, v === "" ? [] : [v])}
                  />
                </li>
              );
            // links: several, as chips with a selector to add one
            const more = pool.filter((t) => !chosen.includes(t.source));
            return (
              <li key={a.key}>
                {key}
                <Flex wrap="wrap" gap="1" align="center">
                  {chosen.map((v) => (
                    <Badge key={v} variant="soft" color="gray" size="2">
                      {v}
                      <IconButton variant="ghost" size="1" color="gray" aria-label={`Remove ${v}`} onClick={() => onAttribute(a.key, chosen.filter((c) => c !== v))}>
                        <Cross2Icon />
                      </IconButton>
                    </Badge>
                  ))}
                  <Pick
                    size="1"
                    label={`Add to ${a.key} of ${name.source}`}
                    value=""
                    disabled={more.length === 0}
                    options={[{ value: "", label: more.length === 0 && chosen.length === 0 ? `no ${a.target ?? "topic"} yet` : "add…" }, ...more.map((t) => ({ value: t.source, label: shown(t) }))]}
                    onChange={(v) => v !== "" && onAttribute(a.key, [...chosen, v])}
                  />
                </Flex>
              </li>
            );
          })}
          {hidden.length > 0 && (
            <li className="tree-action">
              <Pick size="1" variant="ghost" label={`Add a detail to ${name.source}`} value="" options={[{ value: "", label: "+ Add detail" }, ...hidden.map((a) => ({ value: a.key, label: a.key }))]} onChange={(v) => v !== "" && setAdded((x) => [...x, v])} />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
