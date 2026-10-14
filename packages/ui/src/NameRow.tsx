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

/** A text field that keeps what is being typed and saves it when the field is left (Enter saves, Escape goes back). */
function TextField({ value, label, placeholder, onSave }: { value: string; label: string; placeholder?: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
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

/**
 * One word of the block. The line says what it is: the word, its English name, and whether it is used in this block. Opening it shows
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
  onKind,
  onAttribute,
}: {
  name: GuidedName;
  classes: ClassInfo[];
  topics: TopicRef[];
  expanded: boolean;
  focused: boolean;
  /** The word was clicked: it is shown in the source, and its attributes open or close. */
  onToggle: () => void;
  onUse: (use: boolean) => void;
  onOpen: () => void;
  onEnglish: (english: string) => void;
  onKind: (kind: string) => void;
  onAttribute: (key: string, values: string[]) => void;
}) {
  const def = classes.find((c) => c.name === name.kind);
  const attrs = name.attrs ?? {};
  const used = name.use !== false;
  const shown = (t: TopicRef) => (t.english.trim() !== "" ? `${t.english.trim()} (${t.source})` : t.source);
  const poolFor = (a: AttributeDef) => topics.filter((t) => t.source !== name.source && (!a.target || t.category === a.target));

  return (
    <li className={used ? "name-item" : "name-item ignored"}>
      <div className="glossary-head">
        <button className={focused ? "glossary-source focused" : "glossary-source"} onClick={onToggle} aria-expanded={expanded} title="Show where it appears in the block, and its details">
          <span className="chev" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          {name.source}
        </button>
        <span className={name.english.trim() === "" ? "name-english missing" : "name-english"}>{name.english.trim() === "" ? "no English name" : name.english}</span>
        <label className="use-toggle" title={used ? "Used: sent with the block, and added to the knowledge base" : "Ignored in this block"}>
          <input type="checkbox" role="switch" aria-label={`Use ${name.source}`} checked={used} onChange={(e) => onUse(e.target.checked)} />
          <span>{used ? "use" : "ignore"}</span>
        </label>
      </div>
      {expanded && (
        <ul className="tree" aria-label={`Details of ${name.source}`}>
          <li>
            <span className="tree-key">english</span>
            <TextField value={name.english} label={`English name of ${name.source}`} placeholder="English name" onSave={onEnglish} />
          </li>
          <li>
            <span className="tree-key">type</span>
            <select aria-label={`Type of ${name.source}`} value={name.kind} onChange={(e) => onKind(e.target.value)}>
              {classes.length === 0 && <option value={name.kind}>{KIND_LABEL[name.kind] ?? name.kind}</option>}
              {classes.map((c) => (
                <option key={c.name} value={c.name}>
                  {KIND_LABEL[c.name] ?? c.name}
                </option>
              ))}
            </select>
          </li>
          {(def?.attributes ?? []).map((a) => {
            const chosen = attrs[a.key] ?? [];
            if (a.kind === "text")
              return (
                <li key={a.key}>
                  <span className="tree-key">{a.key}</span>
                  <TextField value={chosen.join(", ")} label={`${a.key} of ${name.source}`} onSave={(v) => onAttribute(a.key, v.trim() === "" ? [] : [v.trim()])} />
                </li>
              );
            if (a.kind === "choice")
              return (
                <li key={a.key}>
                  <span className="tree-key">{a.key}</span>
                  <select aria-label={`${a.key} of ${name.source}`} value={chosen[0] ?? ""} onChange={(e) => onAttribute(a.key, e.target.value === "" ? [] : [e.target.value])}>
                    <option value="">not set</option>
                    {(a.choices ?? []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </li>
              );
            const pool = poolFor(a);
            if (a.kind === "link")
              return (
                <li key={a.key}>
                  <span className="tree-key">{a.key}</span>
                  <select aria-label={`${a.key} of ${name.source}`} value={chosen[0] ?? ""} onChange={(e) => onAttribute(a.key, e.target.value === "" ? [] : [e.target.value])} disabled={pool.length === 0 && chosen.length === 0}>
                    <option value="">{pool.length === 0 && chosen.length === 0 ? `no ${a.target ?? "topic"} yet` : "not set"}</option>
                    {chosen[0] && !pool.some((t) => t.source === chosen[0]) && <option value={chosen[0]}>{chosen[0]}</option>}
                    {pool.map((t) => (
                      <option key={t.source} value={t.source}>
                        {shown(t)}
                      </option>
                    ))}
                  </select>
                </li>
              );
            // links: several, as chips with a selector to add one
            const more = pool.filter((t) => !chosen.includes(t.source));
            return (
              <li key={a.key}>
                <span className="tree-key">{a.key}</span>
                <span className="chips">
                  {chosen.map((v) => (
                    <span key={v} className="chip">
                      {v}
                      <button aria-label={`Remove ${v}`} onClick={() => onAttribute(a.key, chosen.filter((c) => c !== v))}>
                        ×
                      </button>
                    </span>
                  ))}
                  <select aria-label={`Add to ${a.key} of ${name.source}`} value="" onChange={(e) => e.target.value !== "" && onAttribute(a.key, [...chosen, e.target.value])} disabled={more.length === 0}>
                    <option value="">{more.length === 0 && chosen.length === 0 ? `no ${a.target ?? "topic"} yet` : "add…"}</option>
                    {more.map((t) => (
                      <option key={t.source} value={t.source}>
                        {shown(t)}
                      </option>
                    ))}
                  </select>
                </span>
              </li>
            );
          })}
          {!name.draft && (
            <li className="tree-action">
              <button className="link-button" onClick={onOpen}>
                Open topic
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
