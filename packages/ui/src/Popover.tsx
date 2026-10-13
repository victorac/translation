import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A small floating panel under its button. Closes on Escape or a click outside, and gives focus back to the button.
 * `children` can be a function that receives `close`.
 */
export function Popover({
  trigger,
  label,
  children,
  align = "left",
  className,
  open: controlled,
  onOpenChange,
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "dialog"; "aria-controls": string }) => ReactNode;
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const set = (v: boolean) => {
    setInner(v);
    onOpenChange?.(v);
  };
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();

  // Place the panel against the whole window (not its parent), so a scrolling or clipped parent can never hide it.
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) {
      setPos(null);
      return;
    }
    const t = root.current.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const margin = 8;
    let left = align === "right" ? t.right - p.width : t.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin));
    let top = t.bottom + 4;
    if (top + p.height > window.innerHeight - margin) top = Math.max(margin, t.top - p.height - 4);
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        set(false);
        root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => set(false);
  return (
    <span className="pop-anchor" ref={root}>
      {trigger({ onClick: () => set(!open), "aria-expanded": open, "aria-haspopup": "dialog", "aria-controls": id })}
      {open && (
        <div
          id={id}
          ref={panel}
          className={`popover ${className ?? ""}`}
          role="dialog"
          aria-label={label}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A line above this item. */
  separated?: boolean;
}

/** A button that opens a short list of actions. */
export function Menu({ label, trigger, items, align = "right" }: { label: string; trigger: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  return (
    <Popover
      label={label}
      align={align}
      className="menu"
      trigger={(p) => (
        <button className="icon-button" aria-label={label} title={label} {...p}>
          {trigger}
        </button>
      )}
    >
      {(close) => (
        <ul role="menu" className="menu-list">
          {items.map((it) => (
            <li key={it.label} role="none" className={it.separated ? "separated" : undefined}>
              <button
                role="menuitem"
                disabled={it.disabled}
                className={it.danger ? "menu-item danger-text" : "menu-item"}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
