import { useCallback, useEffect, useState } from "react";
import type { ConnectionTestResult, ProviderView, SaveProviderInput } from "@ltw/domain";
import { api } from "./api";

/** The saved connection to the local model server, and the "Test connection" action. */
export function useProvider() {
  const [view, setView] = useState<ProviderView | null>(null);
  const [test, setTest] = useState<(ConnectionTestResult & { host: string }) | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke("provider.get").then((r) => {
      if (r.ok) setView(r.value);
    });
  }, []);

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
  return { view, test, testing, saveError, saveAndTest, clearTest };
}
