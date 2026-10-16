import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Badge, Button, Flex, SegmentedControl, Text } from "@radix-ui/themes";
import type { PromptRecord } from "@ltw/domain";
import { api } from "./api";

export type LogLevel = "error" | "warning" | "info";

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  text: string;
}

/** How many entries are kept: the oldest go first. */
const KEPT = 300;

interface LogApi {
  /** Writes down something the user was told (or should know about). */
  log: (level: LogLevel, text: string) => void;
  entries: LogEntry[];
  /** How many errors and warnings came since the log was last opened. */
  unseen: number;
  shown: boolean;
  toggle: () => void;
  clear: () => void;
}

const LogContext = createContext<LogApi>({
  log: () => undefined,
  entries: [],
  unseen: 0,
  shown: false,
  toggle: () => undefined,
  clear: () => undefined,
});

/** The log of the messages of this session: errors, warnings and notices, with when they came. */
export const useLog = () => useContext(LogContext);

const COLOR: Record<LogLevel, "red" | "amber" | "gray"> = {
  error: "red",
  warning: "amber",
  info: "gray",
};

const clock = (t: number): string =>
  new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function LogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [shown, setShown] = useState(false);
  const [seenUpTo, setSeenUpTo] = useState(0);
  const next = useRef(1);

  const log = useCallback((level: LogLevel, text: string) => {
    setEntries((list) =>
      [...list, { id: next.current++, time: Date.now(), level, text }].slice(
        -KEPT,
      ),
    );
  }, []);
  const toggle = useCallback(() => {
    setShown((s) => !s);
    setSeenUpTo(next.current - 1);
  }, []);
  const clear = useCallback(() => setEntries([]), []);
  // While the log is showing, what comes is seen.
  const unseen = shown
    ? 0
    : entries.filter((e) => e.id > seenUpTo && e.level !== "info").length;
  const api = useMemo(
    () => ({ log, entries, unseen, shown, toggle, clear }),
    [log, entries, unseen, shown, toggle, clear],
  );
  return <LogContext.Provider value={api}>{children}</LogContext.Provider>;
}

/** How often the list of requests is read again (a request arrives while the model works, with no event for it). */
const PROMPT_REFRESH_MS = 1500;

/** The requests sent to the model, as sent, with its answers: to see exactly what a translation was made from. */
function PromptList({ records, onClear }: { records: PromptRecord[]; onClear: () => void }) {
  const copy = (r: PromptRecord) => {
    const text = [
      ...r.messages.map((m) => `[${m.role}]\n${m.content}`),
      `[reply]\n${r.reply ?? r.error ?? ""}`,
    ].join("\n\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <>
      <Flex justify="end" px="3" py="1" className="log-panel-head">
        <Button
          size="1"
          variant="ghost"
          color="gray"
          onClick={onClear}
          disabled={records.length === 0}
        >
          Clear
        </Button>
      </Flex>
      <div className="log-list">
        {records.length === 0 ? (
          <Text as="p" size="2" color="gray" m="3">
            Nothing yet. Each request sent to the model is listed here with its
            answer, newest first. It is kept for this session only.
          </Text>
        ) : (
          [...records].reverse().map((r) => (
            <details key={r.id} className="prompt-row">
              <summary>
                <Text size="1" color="gray" className="log-time">
                  {clock(r.time)}
                </Text>
                <Text size="2">{r.purpose}</Text>
                <Text size="1" color="gray">
                  {r.modelId} · {(r.ms / 1000).toFixed(1)}s
                </Text>
                {r.error && (
                  <Badge size="1" variant="soft" color="red">
                    {r.error}
                  </Badge>
                )}
              </summary>
              <div className="prompt-body">
                {r.messages.map((m, i) => (
                  <div key={i}>
                    <Text size="1" color="gray">
                      {m.role}
                    </Text>
                    <pre>{m.content}</pre>
                  </div>
                ))}
                <div>
                  <Text size="1" color="gray">
                    reply · temperature {r.temperature}
                  </Text>
                  <pre>{r.reply ?? ""}</pre>
                </div>
                <Button
                  size="1"
                  variant="soft"
                  color="gray"
                  onClick={() => copy(r)}
                >
                  Copy
                </Button>
              </div>
            </details>
          ))
        )}
      </div>
    </>
  );
}

/** The tray's height in pixels: its default, the least it can be, the most of the window it can take, and where the chosen one is remembered. */
const DEFAULT_HEIGHT = 288;
const LEAST_HEIGHT = 96;
const MOST_OF_WINDOW = 0.85;
const HEIGHT_KEY = "ltw.logHeight";
const readHeight = (): number => {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return n >= LEAST_HEIGHT ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
};

/** The strip at the bottom of the window: how many problems there are (quietly), and a click opens the list above it. */
export function LogDock() {
  const { entries, unseen, shown, toggle, clear } = useLog();
  const [tab, setTab] = useState<"messages" | "prompts">("messages");
  const [records, setRecords] = useState<PromptRecord[]>([]);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const r = await api.invoke("prompts.list", {});
      if (live && r.ok) setRecords((old) => (old.length === r.value.length && old[old.length - 1]?.id === r.value[r.value.length - 1]?.id ? old : r.value));
    };
    void read();
    const t = setInterval(() => void read(), PROMPT_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const clearPrompts = async () => {
    await api.invoke("prompts.clear", {});
    setRecords([]);
  };
  const [height, setHeight] = useState(readHeight);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startHeight = height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => setHeight(Math.min(window.innerHeight * MOST_OF_WINDOW, Math.max(LEAST_HEIGHT, startHeight + startY - m.clientY)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setHeight((h) => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
        } catch {
          // the height is only a convenience
        }
        return h;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const errors = entries.filter((e) => e.level === "error").length;
  const warnings = entries.filter((e) => e.level === "warning").length;
  const copy = () => {
    const text = entries
      .map(
        (e) =>
          `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.text}`,
      )
      .join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <div className="log-dock">
      {shown && (
        <div className="log-panel" style={{ height }}>
          <div className="log-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the log" onPointerDown={drag} />
          <Flex
            align="center"
            justify="between"
            gap="3"
            px="3"
            py="1"
            className="log-panel-head"
          >
            <SegmentedControl.Root
              size="1"
              value={tab}
              onValueChange={(v) => setTab(v as "messages" | "prompts")}
            >
              <SegmentedControl.Item value="messages">
                Messages
              </SegmentedControl.Item>
              <SegmentedControl.Item value="prompts">
                Prompts
              </SegmentedControl.Item>
            </SegmentedControl.Root>
            <Flex gap="2">
              {tab === "messages" && (
                <>
                  <Button
                    size="1"
                    variant="ghost"
                    color="gray"
                    onClick={copy}
                    disabled={entries.length === 0}
                  >
                    Copy all
                  </Button>
                  <Button
                    size="1"
                    variant="ghost"
                    color="gray"
                    onClick={clear}
                    disabled={entries.length === 0}
                  >
                    Clear
                  </Button>
                </>
              )}
              <Button
                size="1"
                variant="ghost"
                color="gray"
                onClick={toggle}
                aria-label="Hide the log"
              >
                Hide
              </Button>
            </Flex>
          </Flex>
          {tab === "prompts" ? (
            <PromptList records={records} onClear={() => void clearPrompts()} />
          ) : (
            <div className="log-list">
              {entries.length === 0 ? (
                <Text as="p" size="2" color="gray" m="3">
                  Nothing yet. Errors, warnings and notices from this session
                  are listed here, newest first.
                </Text>
              ) : (
                [...entries].reverse().map((e) => (
                  <Flex
                    key={e.id}
                    gap="2"
                    align="baseline"
                    px="3"
                    className="log-row"
                  >
                    <Text size="1" color="gray" className="log-time">
                      {clock(e.time)}
                    </Text>
                    <Badge
                      size="1"
                      variant="soft"
                      color={COLOR[e.level]}
                      className="log-level"
                    >
                      {e.level}
                    </Badge>
                    <Text size="2" className="log-text">
                      {e.text}
                    </Text>
                  </Flex>
                ))
              )}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="log-bar"
        aria-expanded={shown}
        onClick={toggle}
        title="The errors, warnings and notices of this session"
      >
        <span>Log</span>
        <span
          className={errors > 0 ? "log-count log-count-error" : "log-count"}
        >
          {errors} {errors === 1 ? "error" : "errors"}
        </span>
        <span
          className={warnings > 0 ? "log-count log-count-warn" : "log-count"}
        >
          {warnings} {warnings === 1 ? "warning" : "warnings"}
        </span>
        <span className="log-count">
          {records.length} {records.length === 1 ? "prompt" : "prompts"}
        </span>
        {unseen > 0 && <span className="log-new">{unseen} new</span>}
      </button>
    </div>
  );
}
