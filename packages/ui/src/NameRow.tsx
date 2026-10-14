import { useEffect, useState } from "react";
import type { AttributeDef, GuidedName } from "@ltw/domain";

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

/**
 * One name of the block: a line to read at a glance, which opens to the choices its topic has. What is offered comes from the
 * classes file: the kind of topic, and every attribute that is a choice or a link to another topic. Free text stays in the topic file.
 */
export function NameRow({ name, classes, topics, focused, onFocus, onAccept, onOpen, onEnglish, onKind, onAttribute }: { name: GuidedName; classes: ClassInfo[]; topics: TopicRef[]; focused: boolean; onFocus: () => void; onAccept: () => void; onOpen: () => void; onEnglish: (english: string) => void; onKind: (kind: string) => void; onAttribute: (key: string, values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [english, setEnglish] = useState(name.english);
  // The glossary may change the English name from elsewhere (the topic file); the box follows it unless it is being typed in.
  useEffect(() => setEnglish(name.english), [name.english]);
  const commit = () => english.trim() !== name.english.trim() && onEnglish(english);
  const def = classes.find((c) => c.name === name.kind);
  const attrs = name.attrs ?? {};
  // Only the choices there is something to choose from: a link to a kind of topic that has none yet is left out until it has one.
  const usable = (a: AttributeDef) => a.kind === "choice" || (attrs[a.key] ?? []).length > 0 || topics.some((t) => t.source !== name.source && (!a.target || t.category === a.target));
  const options = (def?.attributes ?? []).filter((a) => a.kind !== "text" && usable(a));
  const shown = (t: TopicRef) => (t.english.trim() !== "" ? `${t.english.trim()} (${t.source})` : t.source);
  const topicsFor = (a: AttributeDef) => topics.filter((t) => t.source !== name.source && (!a.target || t.category === a.target));

  return (
    <li className="name-item">
      <div className="glossary-head">
        <button className="chev" aria-expanded={open} aria-label={`Choices for ${name.source}`} title="Kind and choices" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"}
        </button>
        <button className={focused ? "glossary-source focused" : "glossary-source"} onClick={onFocus} aria-pressed={focused} title="Show where it appears in the block">
          {name.source}
        </button>
        <input
          className={name.english.trim() === "" ? "english-input missing" : "english-input"}
          aria-label={`English name of ${name.source}`}
          value={english}
          placeholder="English name"
          onChange={(e) => setEnglish(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setEnglish(name.english);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <select className="kind-select" aria-label={`Kind of ${name.source}`} title="What kind of topic this is" value={name.kind} onChange={(e) => onKind(e.target.value)}>
          {classes.length === 0 && <option value={name.kind}>{KIND_LABEL[name.kind] ?? name.kind}</option>}
          {classes.map((c) => (
            <option key={c.name} value={c.name}>
              {KIND_LABEL[c.name] ?? c.name}
            </option>
          ))}
        </select>
        {!name.known && (
          <button className="accept-btn" onClick={onAccept} aria-label={`Accept ${name.source}`} title="Accept this word as it is">
            ✓
          </button>
        )}
      </div>
      {open && (
        <div className="name-attrs">
          {options.map((a) => {
            const chosen = attrs[a.key] ?? [];
            if (a.kind === "choice")
              return (
                <label key={a.key}>
                  {a.key}
                  <select value={chosen[0] ?? ""} onChange={(e) => onAttribute(a.key, e.target.value === "" ? [] : [e.target.value])}>
                    <option value="">not set</option>
                    {(a.choices ?? []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              );
            const pool = topicsFor(a);
            if (a.kind === "link")
              return (
                <label key={a.key}>
                  {a.key}
                  <select value={chosen[0] ?? ""} onChange={(e) => onAttribute(a.key, e.target.value === "" ? [] : [e.target.value])} >
                    <option value="">not set</option>
                    {chosen[0] && !pool.some((t) => t.source === chosen[0]) && <option value={chosen[0]}>{chosen[0]}</option>}
                    {pool.map((t) => (
                      <option key={t.source} value={t.source}>
                        {shown(t)}
                      </option>
                    ))}
                  </select>
                </label>
              );
            // links: several, shown as chips with a selector to add one
            const more = pool.filter((t) => !chosen.includes(t.source));
            return (
              <div key={a.key} className="name-attr-links">
                <span>{a.key}</span>
                <span className="chips">
                  {chosen.map((v) => (
                    <span key={v} className="chip">
                      {v}
                      <button aria-label={`Remove ${v}`} onClick={() => onAttribute(a.key, chosen.filter((c) => c !== v))}>
                        ×
                      </button>
                    </span>
                  ))}
                  <select aria-label={`Add to ${a.key}`} value="" onChange={(e) => e.target.value !== "" && onAttribute(a.key, [...chosen, e.target.value])} disabled={more.length === 0}>
                    <option value="">add…</option>
                    {more.map((t) => (
                      <option key={t.source} value={t.source}>
                        {shown(t)}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
          <button className="link-button" onClick={onOpen}>
            Other details are in the topic file
          </button>
        </div>
      )}
    </li>
  );
}
