import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Flex, Text } from "@radix-ui/themes";

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

const LogContext = createContext<LogApi>({ log: () => undefined, entries: [], unseen: 0, shown: false, toggle: () => undefined, clear: () => undefined });

/** The log of the messages of this session: errors, warnings and notices, with when they came. */
export const useLog = () => useContext(LogContext);

const COLOR: Record<LogLevel, "red" | "amber" | "gray"> = { error: "red", warning: "amber", info: "gray" };

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function LogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [shown, setShown] = useState(false);
  const [seenUpTo, setSeenUpTo] = useState(0);
  const next = useRef(1);

  const log = useCallback((level: LogLevel, text: string) => {
    setEntries((list) => [...list, { id: next.current++, time: Date.now(), level, text }].slice(-KEPT));
  }, []);
  const toggle = useCallback(() => {
    setShown((s) => !s);
    setSeenUpTo(next.current - 1);
  }, []);
  const clear = useCallback(() => setEntries([]), []);
  // While the log is showing, what comes is seen.
  const unseen = shown ? 0 : entries.filter((e) => e.id > seenUpTo && e.level !== "info").length;
  const api = useMemo(() => ({ log, entries, unseen, shown, toggle, clear }), [log, entries, unseen, shown, toggle, clear]);
  return <LogContext.Provider value={api}>{children}</LogContext.Provider>;
}

/** The strip at the bottom of the window: how many problems there are (quietly), and a click opens the list above it. */
export function LogDock() {
  const { entries, unseen, shown, toggle, clear } = useLog();
  const errors = entries.filter((e) => e.level === "error").length;
  const warnings = entries.filter((e) => e.level === "warning").length;
  const copy = () => {
    const text = entries.map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.text}`).join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <div className="log-dock">
      {shown && (
        <div className="log-panel">
          <Flex align="center" justify="between" gap="3" px="3" py="1" className="log-panel-head">
            <Text size="1" weight="bold">
              Log
            </Text>
            <Flex gap="2">
              <Button size="1" variant="ghost" color="gray" onClick={copy} disabled={entries.length === 0}>
                Copy all
              </Button>
              <Button size="1" variant="ghost" color="gray" onClick={clear} disabled={entries.length === 0}>
                Clear
              </Button>
              <Button size="1" variant="ghost" color="gray" onClick={toggle} aria-label="Hide the log">
                Hide
              </Button>
            </Flex>
          </Flex>
          <div className="log-list">
            {entries.length === 0 ? (
              <Text as="p" size="2" color="gray" m="3">
                Nothing yet. Errors, warnings and notices from this session are listed here, newest first.
              </Text>
            ) : (
              [...entries].reverse().map((e) => (
                <Flex key={e.id} gap="2" align="baseline" px="3" className="log-row">
                  <Text size="1" color="gray" className="log-time">
                    {clock(e.time)}
                  </Text>
                  <Badge size="1" variant="soft" color={COLOR[e.level]} className="log-level">
                    {e.level}
                  </Badge>
                  <Text size="2" className="log-text">
                    {e.text}
                  </Text>
                </Flex>
              ))
            )}
          </div>
        </div>
      )}
      <button type="button" className="log-bar" aria-expanded={shown} onClick={toggle} title="The errors, warnings and notices of this session">
        <span>Log</span>
        <span className={errors > 0 ? "log-count log-count-error" : "log-count"}>{errors} {errors === 1 ? "error" : "errors"}</span>
        <span className={warnings > 0 ? "log-count log-count-warn" : "log-count"}>{warnings} {warnings === 1 ? "warning" : "warnings"}</span>
        {unseen > 0 && <span className="log-new">{unseen} new</span>}
      </button>
    </div>
  );
}
