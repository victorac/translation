import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, Cross2Icon } from "@radix-ui/react-icons";
import { Badge, Button, Flex, IconButton, Switch, Text, TextField } from "@radix-ui/themes";
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
function TextBox({ value, label, placeholder, onSave }: { value: string; label: string; placeholder?: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <TextField.Root
      size="1"
      aria-label={label}
      value={text}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value.trim() && onSave(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
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
      <Button variant="ghost" size="1" onClick={onUse} title="Use this value">
        <CheckIcon /> Use
      </Button>
      <IconButton variant="ghost" size="1" color="gray" onClick={onDismiss} aria-label="Drop this suggestion" title="Drop this suggestion">
        <Cross2Icon />
      </IconButton>
    </Flex>
  );
}

/**
 * One word of the text. The line says what it is: the word, its English name, and whether it is used in this block. Opening it shows
 * everything about it as a tree: the English name, the kind and every attribute its kind has, each one editable and saved as it changes.
 */
export function NameRow({
  name,
  classes,
  topics,
  expanded,
  focused,
  onToggle,
  onUse,
  onOpen,
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
  /** The word was clicked: it is shown in the source, and its attributes open or close. */
  onToggle: () => void;
  onUse: (use: boolean) => void;
  onOpen: () => void;
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

  const kindOptions = classes.length === 0 ? [{ value: name.kind, label: KIND_LABEL[name.kind] ?? name.kind }] : classes.map((c) => ({ value: c.name, label: KIND_LABEL[c.name] ?? c.name }));

  return (
    <li className={used ? "name-item" : "name-item ignored"}>
      <Flex align="center" gap="2" className="glossary-head">
        <Button variant={focused ? "soft" : "ghost"} color={focused ? "indigo" : "gray"} size="1" onClick={onToggle} aria-expanded={expanded} title="Show where it appears in the block, and its details" className="glossary-source">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <Text weight="bold" size="2" truncate>
            {name.source}
          </Text>
        </Button>
        {suggestedEnglish !== "" ? (
          <Flex align="center" gap="1" className="name-english">
            <Text size="2" color="gray" style={{ fontStyle: "italic" }} truncate title="Only suggested: not confirmed yet">
              {suggestedEnglish}
            </Text>
            <IconButton variant="ghost" size="1" onClick={() => onAcceptSuggestion("english")} aria-label={`Use ${suggestedEnglish} as the English name of ${name.source}`} title="Use this name">
              <CheckIcon />
            </IconButton>
          </Flex>
        ) : (
          <Text size="2" color={name.english.trim() === "" && !name.hint ? "amber" : undefined} className="name-english" title={name.hint ? `Note to the model: ${name.hint}` : undefined}>
            {name.english.trim() !== "" ? name.english : name.hint ? `note: ${name.hint}` : "no English name"}
          </Text>
        )}
        <Text as="label" size="1" color={used ? "green" : "gray"} weight={used ? "medium" : "regular"} title={used ? "Used: sent with the block, and added to the knowledge base" : "Ignored in this block"}>
          <Flex align="center" gap="1">
            <Switch size="1" color="green" checked={used} onCheckedChange={onUse} aria-label={`Use ${name.source}`} />
            {used ? "use" : "ignore"}
          </Flex>
        </Text>
      </Flex>
      {expanded && (
        <ul className="tree" aria-label={`Details of ${name.source}`}>
          <li>
            <Text size="1" color="gray">english</Text>
            <div className="tree-field">
              <TextBox value={name.english} label={`English name of ${name.source}`} placeholder={suggestedEnglish !== "" ? suggestedEnglish : "English name"} onSave={onEnglish} />
              {suggestedEnglish !== "" && <Suggested text={suggestedEnglish} onUse={() => onAcceptSuggestion("english")} onDismiss={() => onDismissSuggestion("english")} />}
            </div>
          </li>
          <li>
            <Text size="1" color="gray">note</Text>
            <TextBox value={name.hint ?? ""} label={`Note to the model about ${name.source}`} placeholder="A hint for the model (the English name can stay empty)" onSave={onHint} />
          </li>
          <li>
            <Text size="1" color="gray">type</Text>
            <Pick size="1" label={`Type of ${name.source}`} value={name.kind} options={kindOptions} onChange={onKind} />
          </li>
          {(def?.attributes ?? []).map((a) => {
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
          {!name.draft && (
            <li className="tree-action">
              <Button variant="ghost" size="1" onClick={onOpen}>
                Open topic
              </Button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
