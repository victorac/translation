import { useCallback, useEffect, useState } from "react";
import { EMPTY_LAYOUT, parseLayout, type ColumnLayout } from "./layout";
import { parseTree, type PaneNode } from "./paneTree";

const KEY = "ltw.columnLayout.v1";
const PANES_KEY = "ltw.panes.v1";

export type LayoutMode = "aligned" | "panes";

interface Saved {
  mode: LayoutMode;
  tree: PaneNode | null;
  linked: boolean;
  showKnowledge: boolean;
}

function loadColumns(): ColumnLayout {
  try {
    return parseLayout(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return EMPTY_LAYOUT;
  }
}

function loadPanes(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) ?? "null") as Partial<Saved> | null;
    return { mode: raw?.mode === "panes" ? "panes" : "aligned", tree: parseTree(raw?.tree), linked: raw?.linked !== false, showKnowledge: raw?.showKnowledge === true };
  } catch {
    return { mode: "aligned", tree: null, linked: true, showKnowledge: false };
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable; the layout then lasts for this session only */
  }
}

/** How the workspace is arranged (aligned columns or free panes), remembered between sessions on this computer. */
export function useColumnLayout() {
  const [layout, setLayout] = useState<ColumnLayout>(loadColumns);
  const [panes, setPanes] = useState<Saved>(loadPanes);
  useEffect(() => save(KEY, layout), [layout]);
  useEffect(() => save(PANES_KEY, panes), [panes]);
  const reset = useCallback(() => {
    setLayout(EMPTY_LAYOUT);
    setPanes((p) => ({ ...p, tree: null }));
  }, []);
  return {
    layout,
    setLayout,
    reset,
    mode: panes.mode,
    setMode: (mode: LayoutMode) => setPanes((p) => ({ ...p, mode })),
    tree: panes.tree,
    setTree: (tree: PaneNode) => setPanes((p) => ({ ...p, tree })),
    linked: panes.linked,
    setLinked: (linked: boolean) => setPanes((p) => ({ ...p, linked })),
    showKnowledge: panes.showKnowledge,
    setShowKnowledge: (showKnowledge: boolean) => setPanes((p) => ({ ...p, showKnowledge })),
  };
}
