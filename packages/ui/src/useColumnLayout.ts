import { useCallback, useEffect, useState } from "react";
import { EMPTY_LAYOUT, parseLayout, type ColumnLayout } from "./layout";

const KEY = "ltw.columnLayout.v1";

function load(): ColumnLayout {
  try {
    return parseLayout(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return EMPTY_LAYOUT;
  }
}

/** The column order and widths, remembered between sessions on this computer. */
export function useColumnLayout() {
  const [layout, setLayout] = useState<ColumnLayout>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      /* storage may be unavailable; the layout then lasts for this session only */
    }
  }, [layout]);
  const reset = useCallback(() => setLayout(EMPTY_LAYOUT), []);
  return { layout, setLayout, reset };
}
