import { useEffect, useMemo, useState } from "react";
import type { SplitPreview, StartJobInput } from "@ltw/domain";
import { api } from "./api";

/** Asks the background process how the text would be split, shortly after the user stops typing. */
export function useSplitPreview(input: StartJobInput): { preview: SplitPreview | null; loading: boolean } {
  const key = useMemo(() => JSON.stringify(input), [input]);
  const [state, setState] = useState<{ preview: SplitPreview | null; loading: boolean }>({ preview: null, loading: false });

  useEffect(() => {
    if (input.text.trim() === "") {
      setState({ preview: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      void api.invoke("source.preview", JSON.parse(key) as StartJobInput).then((r) => {
        if (live) setState({ preview: r.ok ? r.value : null, loading: false });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, input.text]);

  return state;
}
