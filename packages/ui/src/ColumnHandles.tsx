import { useRef } from "react";
import { clampWidth } from "./layout";

/** A thin divider on a column's right edge. Drag it, or focus it and use the arrow keys; double-click to undo the width. */
export function ResizeHandle({
  label,
  measure,
  onResize,
  onReset,
}: {
  label: string;
  /** The column's current width in pixels. */
  measure: () => number;
  onResize: (px: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: measure() };
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(clampWidth(start.current.w + e.clientX - start.current.x));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const step = (e.shiftKey ? 80 : 20) * (e.key === "ArrowLeft" ? -1 : 1);
          onResize(clampWidth(measure() + step));
        } else if (e.key === "Escape" || e.key === "Enter") onReset();
      }}
    />
  );
}
