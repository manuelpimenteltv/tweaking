"use client";

import { ArrowUpRight, Check, Circle, Highlighter, Minus, PenLine, Square, Trash2, Type, Undo2 } from "lucide-react";
import type { AnnotationTool } from "@/server/db/schema";
import { ANNOTATION_COLORS } from "@/lib/review";
import { cn } from "@/lib/cn";
import type { DrawSettings } from "./annotation-layer";

const TOOLS: { tool: AnnotationTool; label: string; icon: typeof PenLine; key: string }[] = [
  { tool: "freehand", label: "Freehand", icon: PenLine, key: "1" },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight, key: "2" },
  { tool: "line", label: "Line", icon: Minus, key: "3" },
  { tool: "rect", label: "Rectangle", icon: Square, key: "4" },
  { tool: "ellipse", label: "Circle / ellipse", icon: Circle, key: "5" },
  { tool: "text", label: "Text", icon: Type, key: "6" },
  { tool: "highlight", label: "Highlighter", icon: Highlighter, key: "7" },
];
const WIDTHS = [
  { label: "Thin", value: 2 },
  { label: "Medium", value: 4 },
  { label: "Thick", value: 8 },
];

export function DrawToolbar({
  settings,
  onChange,
  count,
  onUndo,
  onClear,
  onDone,
}: {
  settings: DrawSettings;
  onChange: (s: DrawSettings) => void;
  count: number;
  onUndo: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Annotation tools" className="flex flex-wrap items-center gap-1 border-b border-white/5 bg-surface-1 px-3 py-1.5" data-testid="draw-toolbar">
      {TOOLS.map(({ tool, label, icon: Icon, key }) => (
        <button
          key={tool}
          type="button"
          aria-label={label}
          title={`${label} (${key})`}
          aria-pressed={settings.tool === tool}
          onClick={() => onChange({ ...settings, tool })}
          className={cn("grid size-7 place-items-center rounded-md", settings.tool === tool ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-3 hover:text-text")}
        >
          <Icon size={15} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Color ${c}`}
          aria-pressed={settings.color === c}
          onClick={() => onChange({ ...settings, color: c })}
          className={cn("size-5 rounded-full ring-offset-2 ring-offset-[var(--surface-1)]", settings.color === c && "ring-2 ring-text")}
          style={{ background: c, border: "1px solid rgb(255 255 255 / 0.2)" }}
        />
      ))}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {WIDTHS.map((w) => (
        <button
          key={w.value}
          type="button"
          aria-label={`${w.label} stroke`}
          aria-pressed={settings.width === w.value}
          onClick={() => onChange({ ...settings, width: w.value })}
          className={cn("grid size-7 place-items-center rounded-md", settings.width === w.value ? "bg-surface-3" : "hover:bg-surface-3")}
        >
          <span className="rounded-full bg-text" style={{ width: 14, height: Math.max(1.5, w.value / 2) }} />
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-1 text-[12px] text-muted tabular">{count} shape{count === 1 ? "" : "s"}</span>
        <button type="button" onClick={onUndo} disabled={!count} aria-label="Undo last shape" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 disabled:opacity-40">
          <Undo2 size={15} />
        </button>
        <button type="button" onClick={onClear} disabled={!count} aria-label="Clear drawing" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 disabled:opacity-40">
          <Trash2 size={15} />
        </button>
        <button type="button" onClick={onDone} className="ml-1 inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg">
          <Check size={13} /> Done
        </button>
      </div>
    </div>
  );
}
