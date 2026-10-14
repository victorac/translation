/**
 * Classes say what kinds of topic there are and which attributes each kind has, in a small text format:
 *
 *   # character
 *   gender: choice(male, female, unknown)
 *   age: text
 *   family: link(family)
 *   member of: links(organization)
 *
 * `text` is free text, `choice(...)` is one of the listed values, `link(class)` points to one topic and
 * `links(class)` to several. Attributes are what the translator is told about a topic, and what extraction fills in.
 */
export type AttributeKind = "text" | "choice" | "link" | "links";

export interface AttributeDef {
  key: string;
  kind: AttributeKind;
  /** Choices, for `choice`. */
  choices?: string[];
  /** The class a link points to, for `link` and `links`. Empty means any. */
  target?: string;
}

export interface ClassDef {
  name: string;
  attributes: AttributeDef[];
}

/** The classes text projects were given before it explained itself. A project that still has it gets the new text. */
export const LEGACY_CLASSES_TEXT = `# character
gender: choice(male, female, other, unknown)
age: text
role: text
speech style: text
first person: text
family: link(family)
member of: links(organization)
lives in: link(place)

# place
located in: link(place)

# organization
based in: link(place)
leader: link(character)

# family
head: link(character)
home: link(place)

# term
`;

/** The classes text of the version before terms could refer to a person. A project that still has it gets the new text. */
export const PREVIOUS_CLASSES_TEXT = `<!-- Classes are the kinds of topic, and the attributes each kind has. Add your own with a line that starts with #. -->
<!-- Every topic file also begins with these lines, whatever its class: -->
<!--   type: its class -->
<!--   name: how it is written in the text -->
<!--   english: how it is translated -->
<!--   aliases: other ways it is written, separated by commas (for example: 花ちゃん, 花子さん) -->
<!-- An attribute is written as  name: kind  where kind is one of: -->
<!--   text            any text -->
<!--   choice(a, b)    one of the listed values -->
<!--   link(class)     a link to one topic of that class, written [[like this]] in the file -->
<!--   links(class)    links to several topics, separated by commas -->
<!-- What an attribute says is told to the translator along with the topic's name, so choose the ones that matter. -->

# character
gender: choice(male, female, other, unknown)
age: text
role: text
speech style: text
first person: text
family: link(family)
member of: links(organization)
lives in: link(place)

# place
located in: link(place)

# organization
based in: link(place)
leader: link(character)

# family
head: link(character)
home: link(place)

# term
`;

export const DEFAULT_CLASSES_TEXT = `<!-- Classes are the kinds of topic, and the attributes each kind has. Add your own with a line that starts with #. -->
<!-- Every topic file also begins with these lines, whatever its class: -->
<!--   type: its class -->
<!--   name: how it is written in the text -->
<!--   english: how it is translated -->
<!--   aliases: other ways it is written, separated by commas (for example: 花ちゃん, 花子さん) -->
<!-- An attribute is written as  name: kind  where kind is one of: -->
<!--   text            any text -->
<!--   choice(a, b)    one of the listed values -->
<!--   link(class)     a link to one topic of that class, written [[like this]] in the file -->
<!--   links(class)    links to several topics, separated by commas -->
<!-- What an attribute says is told to the translator along with the topic's name, so choose the ones that matter. -->

# character
gender: choice(male, female, other, unknown)
age: text
role: text
speech style: text
first person: text
family: link(family)
member of: links(organization)
lives in: link(place)

# place
located in: link(place)

# organization
based in: link(place)
leader: link(character)

# family
head: link(character)
home: link(place)

# term
refers to: link(character)
`;

/** Is this the classes text a project was given by an earlier version, which nobody changed? */
export const isOldDefaultClasses = (text: string): boolean => text === LEGACY_CLASSES_TEXT || text === PREVIOUS_CLASSES_TEXT;

/** How a class is named in lists. */
export function classLabel(name: string): string {
  const known: Record<string, string> = { character: "Characters", place: "Places", organization: "Organizations", family: "Families", term: "Other terms" };
  return known[name] ?? `${name[0]?.toLocaleUpperCase() ?? ""}${name.slice(1)}s`;
}

const KIND = /^(text|choice|links?)\s*(?:\((.*)\))?$/i;

export function parseClasses(text: string): { classes: ClassDef[]; problems: { line: number; message: string }[] } {
  const classes: ClassDef[] = [];
  const problems: { line: number; message: string }[] = [];
  let current: ClassDef | null = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/<!--.*?-->/g, "").trim();
    if (line === "") return;
    const n = i + 1;
    const head = /^#\s+(.+)$/.exec(line);
    if (head) {
      const name = head[1]!.trim().toLocaleLowerCase();
      if (classes.some((c) => c.name === name)) problems.push({ line: n, message: `The class "${name}" is defined twice.` });
      current = { name, attributes: [] };
      classes.push(current);
      return;
    }
    if (!current) return void problems.push({ line: n, message: "Start with the name of a class, for example: # character" });
    const m = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
    const k = m ? KIND.exec(m[2]!.trim()) : null;
    if (!m || !k) return void problems.push({ line: n, message: "Write an attribute as: name: text, name: choice(a, b), name: link(class) or name: links(class)" });
    const kind = k[1]!.toLocaleLowerCase() as AttributeKind;
    const args = (k[2] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    if (kind === "choice" && args.length === 0) return void problems.push({ line: n, message: "A choice needs the values to choose from, for example: choice(male, female)" });
    const def: AttributeDef = { key: m[1]!.trim().toLocaleLowerCase(), kind };
    if (kind === "choice") def.choices = args;
    if (kind === "link" || kind === "links") def.target = (args[0] ?? "").toLocaleLowerCase();
    current.attributes.push(def);
  });
  return { classes, problems };
}
