import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Dialog, Flex, Text } from "@radix-ui/themes";

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
  /** How many errors and warnings came since the log was last opened. */
  unseen: number;
  open: () => void;
}

const LogContext = createContext<LogApi>({ log: () => undefined, unseen: 0, open: () => undefined });

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
  const unseen = entries.filter((e) => e.id > seenUpTo && e.level !== "info").length;
  const open = useCallback(() => {
    setShown(true);
    setSeenUpTo(next.current - 1);
  }, []);
  const api = useMemo(() => ({ log, unseen, open }), [log, unseen, open]);

  const copy = () => {
    const text = entries.map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.text}`).join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <LogContext.Provider value={api}>
      {children}
      <Dialog.Root
        open={shown}
        onOpenChange={(o) => {
          setShown(o);
          if (o) setSeenUpTo(next.current - 1);
        }}
      >
        <Dialog.Content maxWidth="44rem" aria-describedby={undefined}>
          <Flex align="center" justify="between" gap="3" mb="3">
            <Dialog.Title mb="0">Log</Dialog.Title>
            <Flex gap="2">
              <Button size="1" variant="soft" color="gray" onClick={copy} disabled={entries.length === 0}>
                Copy all
              </Button>
              <Button size="1" variant="soft" color="gray" onClick={() => setEntries([])} disabled={entries.length === 0}>
                Clear
              </Button>
              <Dialog.Close>
                <Button size="1">Close</Button>
              </Dialog.Close>
            </Flex>
          </Flex>
          <div className="log-list">
            {entries.length === 0 ? (
              <Text as="p" size="2" color="gray">
                Nothing yet. Errors, warnings and notices from this session are listed here, newest first.
              </Text>
            ) : (
              [...entries].reverse().map((e) => (
                <Flex key={e.id} gap="2" align="baseline" className="log-row">
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
        </Dialog.Content>
      </Dialog.Root>
    </LogContext.Provider>
  );
}
