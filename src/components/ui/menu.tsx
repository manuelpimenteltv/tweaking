"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";

export type MenuItem =
  | { type?: "item"; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | { type: "separator" };

/** Accessible dropdown / context menu: arrow keys, Escape, click-outside. */
export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div ref={wrap} className="relative inline-flex">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu" })}
      {open && <MenuList items={items} onClose={() => setOpen(false)} anchor={wrap} align={align} />}
    </div>
  );
}

export function MenuList({
  items,
  onClose,
  anchor,
  point,
  align = "end",
}: {
  items: MenuItem[];
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (point) {
      left = point.x;
      top = point.y;
    } else if (anchor?.current) {
      const r = anchor.current.getBoundingClientRect();
      left = align === "end" ? r.right - w : r.left;
      top = r.bottom + 4;
    } else return;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) top = Math.max(8, top - h - (point ? 0 : 36));
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [anchor, point, align]);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-44 rounded-md bg-surface-2 p-1"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, boxShadow: "var(--shadow)" }}
    >
      {items.map((item, i) =>
        item.type === "separator" ? (
          <div key={i} className="my-1 h-px bg-border" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] outline-none focus:bg-surface-4 hover:bg-surface-4 disabled:opacity-40",
              item.danger ? "text-danger" : "text-text",
            )}
          >
            <span className="flex w-4 justify-center text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <span className="font-mono text-[11px] text-faint">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
