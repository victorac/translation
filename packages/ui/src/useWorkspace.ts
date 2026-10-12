import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandMap, SnapshotCommand, WorkspaceSnapshot } from "@ltw/domain";
import { api } from "./api";

/** Keeps the latest picture of the workspace from the background process. */
export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        dirty.current = false;
        const r = await api.invoke("workspace.snapshot");
        if (r.ok) setSnapshot(r.value);
        else setError(r.error.message);
      } while (dirty.current);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.onEvent(() => void refresh());
  }, [refresh]);

  const send = useCallback(async <C extends SnapshotCommand>(command: C, ...payload: CommandMap[C] extends undefined ? [] : [CommandMap[C]]) => {
    const r = await api.invoke(command, ...payload);
    if (r.ok) {
      setSnapshot(r.value);
      setError(null);
    } else setError(r.error.message);
    return r.ok;
  }, []);

  return { snapshot, error, clearError: () => setError(null), send };
}
