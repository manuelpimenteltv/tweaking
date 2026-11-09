"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "./button";

/**
 * Modal built on the native <dialog> element: focus trapping, Escape to close
 * and inert background come from the platform.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className="m-auto max-h-[85dvh] rounded-lg bg-surface-1 p-0 text-text"
      style={{ width: `min(${width}px, calc(100vw - 32px))`, boxShadow: "var(--shadow)" }}
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-4">
            <div>
              <h2 id="dialog-title" className="text-[15px] font-semibold">
                {title}
              </h2>
              {description && <div className="mt-1 text-[13px] text-muted">{description}</div>}
            </div>
            <IconButton label="Close" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
          {children && <div className="px-5 py-4">{children}</div>}
          {footer && <div className={cn("flex justify-end gap-2 border-t border-border px-5 py-3")}>{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
