import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionTestResult, ProviderView, SaveProviderInput } from "@ltw/domain";
import { api } from "./api";

/** The saved connection to the local model server, and the "Test connection" action. */
export function useProvider() {
  const [view, setView] = useState<ProviderView | null>(null);
  const [test, setTest] = useState<(ConnectionTestResult & { host: string }) | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const viewRef = useRef<ProviderView | null>(null);
  viewRef.current = view;

  /** Asks the saved server for its models, without changing anything. */
  const refresh = useCallback(async () => {
    setTesting(true);
    try {
      const t = await api.invoke("provider.test");
      if (t.ok) setTest({ ...t.value, host: viewRef.current?.host ?? "" });
    } finally {
      setTesting(false);
    }
  }, []);

  const checked = useRef(false);
  useEffect(() => {
    void api.invoke("provider.get").then((r) => {
      if (r.ok) setView(r.value);
    });
  }, []);
  // Connect by itself at startup, so the models are there without a visit to the settings.
  useEffect(() => {
    if (view && !view.problem && !checked.current) {
      checked.current = true;
      void refresh();
    }
  }, [view, refresh]);

  /** Saves the address (and key) and then asks the server for its models. */
  const saveAndTest = useCallback(async (input: SaveProviderInput) => {
    setSaveError(null);
    setTest(null);
    setTesting(true);
    try {
      const saved = await api.invoke("provider.save", input);
      if (!saved.ok) {
        setSaveError(saved.error.message);
        return;
      }
      setView(saved.value);
      const t = await api.invoke("provider.test");
      if (t.ok) setTest({ ...t.value, host: saved.value.host });
      else setSaveError(t.error.message);
    } finally {
      setTesting(false);
    }
  }, []);

  const clearTest = useCallback(() => setTest(null), []);
  return { view, test, testing, saveError, saveAndTest, clearTest, refresh };
}
