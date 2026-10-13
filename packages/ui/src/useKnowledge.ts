import { useEffect, useState } from "react";
import type { EntryQuery, KnowledgeList } from "@ltw/domain";
import { api } from "./api";

/** The project's names, hints and notes that match a search. Asks again whenever they change (`rev`). */
export function useKnowledgeList(rev: number, query: EntryQuery): KnowledgeList | null {
  const [list, setList] = useState<KnowledgeList | null>(null);
  const key = JSON.stringify(query);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api.invoke("knowledge.list", query).then((r) => {
        if (live && r.ok) setList(r.value);
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rev, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}
