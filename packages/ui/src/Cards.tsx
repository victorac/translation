import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Cross2Icon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";
import { Badge, Button, Flex, IconButton, Text } from "@radix-ui/themes";
import type { Word, WorkLine } from "@ltw/domain";
import { kindClass, type Place } from "./editorShared";
import { Details, EnglishField, WordMenu, englishState, type ClassInfo, type TopicRef, type WordActions } from "./NameRow";
import { Pick } from "./Pick";

/** Whether an element is part of a dropdown or a menu that opened from a card (they are drawn outside it, over the page). */
const inPopup = (el: Element | null): boolean => !!el?.closest("[data-radix-popper-content-wrapper], [role=listbox], [role=menu]");

/**
 * A card next to a place in the text: below it, or above it when there is no room below. A pinned card closes with Escape or a click
 * anywhere else (but not in a dropdown opened from it).
 */
export function Floating({
  place,
  within,
  pinned,
  onClose,
  onEnter,
  onLeave,
  label,
  children,
}: {
  place: Place;
  /** The pane of what the card is about: the card stays inside it (unless it is narrower than the card), so it covers nothing of the other one. */
  within?: HTMLElement | null;
  pinned: boolean;
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ left: place.left, top: place.bottom + 6, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pane = within?.getBoundingClientRect();
    const lo = Math.max(8, (pane?.left ?? 0) + 4);
    const hi = Math.min(window.innerWidth, pane?.right ?? window.innerWidth) - width - 8;
    const left = Math.max(lo, Math.min(place.left, hi));
    const below = place.bottom + 6;
    const top = below + height > window.innerHeight - 8 && place.top - height - 6 > 8 ? place.top - height - 6 : Math.max(8, Math.min(below, window.innerHeight - height - 8));
    setStyle({ left, top });
  }, [place.left, place.top, place.bottom, within, children]);
  // Listened to for as long as the card is pinned, whatever is drawn meanwhile: a press in an editor draws the page again before it
  // reaches the document, and listening again each time would miss it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (box.current?.contains(target) || inPopup(target)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close.current();
    // Listened to from the next moment on: the press that opened the card may still be on its way up to the page, and is not a click elsewhere.
    const start = setTimeout(() => document.addEventListener("mousedown", onDown));
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(start);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);
  return (
    <div ref={box} className={pinned ? "card card-pinned" : "card"} style={style} role={pinned ? "dialog" : "tooltip"} aria-label={label} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      {children}
    </div>
  );
}

const STATE_BADGE = { fixed: { color: "green", text: "fixed" }, suggested: { color: "amber", text: "suggested" } } as const;

/** The head of a word's card: the word, its kind and how many times it stands in the text. */
function CardHead({ word, kindLabel, places, onClose }: { word: Word; kindLabel: string; places: number; onClose?: () => void }) {
  return (
    <Flex align="start" justify="between" gap="2">
      <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
        <Text size="4" weight="bold" className="card-source">
          {word.source}
        </Text>
        <Flex align="center" gap="2" wrap="wrap">
          <Badge size="1" variant="soft" color="gray" className={`card-kind ${kindClass(word.kind)}`}>
            {kindLabel}
          </Badge>
          {word.use === false && (
            <Badge size="1" variant="soft" color="gray">
              ignored in this text
            </Badge>
          )}
          <Text size="1" color="gray">
            {places === 0 ? "not in the text" : places === 1 ? "1 place in the text" : `${places} places in the text`}
          </Text>
        </Flex>
      </Flex>
      {onClose && (
        <IconButton variant="ghost" size="1" color="gray" onClick={onClose} aria-label="Close">
          <Cross2Icon />
        </IconButton>
      )}
    </Flex>
  );
}

/** What a word is, to read: shown while the pointer rests on it. A click on the word pins the card to change it. */
export function WordPeek({ word, kindLabel, places }: { word: Word; kindLabel: string; places: number }) {
  const state = englishState(word);
  const english = state === "fixed" ? word.english : state === "suggested" ? word.suggestions!["english"]![0]! : "";
  const attrs = Object.entries(word.attrs ?? {}).filter(([, v]) => v.length > 0);
  const suggested = Object.entries(word.suggestions ?? {}).filter(([k, v]) => k !== "english" && v.length > 0 && (word.attrs?.[k] ?? []).length === 0);
  return (
    <Flex direction="column" gap="2">
      <CardHead word={word} kindLabel={kindLabel} places={places} />
      <Flex align="center" gap="2">
        {english === "" ? (
          <Text size="2" color="gray">
            No English name yet
          </Text>
        ) : (
          <Text size="3" style={state === "suggested" ? { fontStyle: "italic" } : undefined}>
            {english}
          </Text>
        )}
        {state && (
          <Badge size="1" variant="soft" color={STATE_BADGE[state].color}>
            {STATE_BADGE[state].text}
          </Badge>
        )}
      </Flex>
      {word.reading && (
        <Text size="1" color="gray">
          Read as {word.reading}
        </Text>
      )}
      {word.hint && (
        <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
          {word.hint}
        </Text>
      )}
      {(attrs.length > 0 || suggested.length > 0) && (
        <dl className="card-attrs">
          {attrs.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v.join(", ")}</dd>
            </div>
          ))}
          {suggested.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <em>{v.join(", ")}</em> <Text color="amber">suggested</Text>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Text size="1" color="gray">
        Click the word to change it.
      </Text>
    </Flex>
  );
}

/** A word's card pinned to change it: the English name, the details, where it stands in the text, and the rest from the menu. */
export function WordEdit({
  word,
  kindLabel,
  places,
  classes,
  topics,
  actions,
  onClose,
  find,
}: {
  word: Word;
  kindLabel: string;
  places: number;
  classes: ClassInfo[];
  topics: TopicRef[];
  actions: WordActions;
  onClose: () => void;
  /** Asking the model where this place of the word is in the other text. */
  find?: { label: string; disabled: boolean; run: () => void };
}) {
  const used = word.use !== false;
  return (
    <Flex direction="column" gap="3">
      <CardHead word={word} kindLabel={kindLabel} places={places} onClose={onClose} />
      {used ? (
        <Flex direction="column" gap="1" className="card-english">
          <Text size="1" color="gray">
            English name
          </Text>
          <EnglishField name={word} actions={actions} />
        </Flex>
      ) : (
        <Button variant="soft" onClick={() => actions.onUse(true)}>
          Use in this text
        </Button>
      )}
      <Details
        subject={{ source: word.source, kind: word.kind, hint: word.hint ?? "", attrs: word.attrs ?? {}, suggestions: word.suggestions ?? {} }}
        classes={classes}
        topics={topics}
        onKind={actions.onKind}
        onHint={actions.onHint}
        onAttribute={actions.onAttribute}
        onAcceptSuggestion={actions.onAcceptSuggestion}
        onDismissSuggestion={actions.onDismissSuggestion}
      />
      <Flex align="center" justify="between" gap="2">
        <Flex gap="3" wrap="wrap">
          <Button variant="ghost" size="1" onClick={actions.onLocate} disabled={places === 0}>
            <MagnifyingGlassIcon /> Show each place
          </Button>
          {find && (
            <Button variant="ghost" size="1" onClick={find.run} disabled={find.disabled}>
              <ReloadIcon /> {find.label}
            </Button>
          )}
        </Flex>
        <WordMenu name={word} actions={actions} />
      </Flex>
    </Flex>
  );
}

/** Who says a line of speech: chosen from everyone who can speak, as a suggestion until it is fixed. */
export function LineEdit({
  line,
  index,
  people,
  onSpeaker,
  onFix,
  onClose,
}: {
  line: WorkLine;
  index: number;
  people: { value: string; label: string }[];
  /** A speaker was chosen (or "" for not known). */
  onSpeaker: (speaker: string) => void;
  /** The speaker is made fixed, or a suggestion again. */
  onFix: () => void;
  onClose: () => void;
}) {
  const fixed = line.speaker !== null;
  const shown = line.speaker ?? line.suggested ?? "";
  return (
    <Flex direction="column" gap="2">
      <Flex align="start" justify="between" gap="2">
        <Text size="2" className="card-line">
          {line.text}
        </Text>
        <IconButton variant="ghost" size="1" color="gray" onClick={onClose} aria-label="Close">
          <Cross2Icon />
        </IconButton>
      </Flex>
      <Text size="1" color="gray">
        Who says it
      </Text>
      <Flex align="center" gap="2">
        <Pick size="2" label={`Speaker of line ${index + 1}`} value={shown} options={[{ value: "", label: "not known" }, ...people]} onChange={onSpeaker} />
        {shown !== "" && (
          <Button
            size="1"
            variant="soft"
            color={fixed ? "green" : "amber"}
            onClick={onFix}
            title={fixed ? "Fixed: the model is told who says the line. Click to make it a suggestion again." : "Suggested: shown here, not told to the model. Click to fix it: the model is told who says the line."}
          >
            {fixed ? "fixed" : "suggested"}
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

/**
 * What can be done with a selection, as a small menu under it, kept inside its own pane (it does not cover the other text, where a
 * match is shown). It closes on a press anywhere else, or Escape; the page closes it after an action too.
 */
export function SelectionMenu({ at, within, onClose, children }: { at: { left: number; bottom: number }; within: HTMLElement | null; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(at.left);
  useLayoutEffect(() => {
    const width = box.current?.offsetWidth ?? 0;
    const pane = within?.getBoundingClientRect();
    const lo = (pane?.left ?? 0) + 4;
    const hi = (pane?.right ?? window.innerWidth) - width - 8;
    setLeft(Math.max(lo, Math.min(at.left, hi)));
  }, [at.left, at.bottom, within, children]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Seen before the editor takes the press, so a new selection starts with the menu closed (and it opens again on the new one).
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close.current();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div ref={box} className="select-bar" role="menu" aria-label="What to do with the selection" style={{ left, top: at.bottom + 6 }}>
      {children}
    </div>
  );
}
