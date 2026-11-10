"use client";

import { MessageSquare, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { ReviewThread } from "@/server/modules/review";
import type { Anchor } from "@/lib/review";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { CommentsPanel } from "./comments-panel";
import type { Review } from "./use-review";

const PANEL_MIN = 300;

export type ShellProps = {
  review: Review;
  orgSlug: string;
  version: { id: string; number: number };
  canComment: boolean;
  currentUserId: string;
  details: ReactNode;
  /** The primary viewing area (player, document, sheet, image). */
  main: ReactNode;
  position: { label: string; anchor: Anchor } | null;
  describe: (t: ReviewThread) => string | null;
  monoLabels?: boolean;
  onSelectThread: (t: ReviewThread) => void;
  /** Start drawing at the current position; omit when the medium has no drawings. */
  onStartDrawing?: () => void;
  draftLabel: string | null;
  draftOffPosition: boolean;
  onGoToDraft: () => void;
  emptyHint: string;
  pause?: () => void;
};

/**
 * Two-panel review layout shared by every viewer: the medium is the primary
 * area; comments and details live in a secondary panel that can be resized
 * (drag or arrow keys on the divider) and collapsed. Both are remembered.
 */
export function ReviewShell(p: ShellProps) {
  const r = p.review;
  const clampWidth = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, Math.max(PANEL_MIN, window.innerWidth * 0.6))));
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = r.panelWidth;
    const move = (ev: PointerEvent) => r.setPanelWidth(clampWidth(startW - (ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">{p.main}</div>
      {r.collapsed ? (
        <button
          type="button"
          onClick={() => r.setCollapsed(false)}
          className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface-1 pt-3 text-muted hover:text-text"
          aria-label="Show comments panel"
        >
          <MessageSquare size={16} />
          <span className="text-[11px] tabular">{r.data.counts.open}</span>
        </button>
      ) : (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize comments panel"
            aria-valuenow={r.panelWidth}
            aria-valuemin={PANEL_MIN}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") r.setPanelWidth(clampWidth(r.panelWidth + 24));
              if (e.key === "ArrowRight") r.setPanelWidth(clampWidth(r.panelWidth - 24));
            }}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent focus-visible:bg-accent"
          />
          <aside className="flex shrink-0 flex-col bg-surface-1" style={{ width: r.panelWidth }} aria-label="Review panel" data-testid="review-panel">
            <div role="tablist" className="flex gap-4 border-b border-border px-4 pt-2">
              {(["comments", "details"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={r.tab === t}
                  onClick={() => r.setTab(t)}
                  className={cn("-mb-px border-b-2 pb-2 text-[13px]", r.tab === t ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}
                >
                  {t === "comments" ? `Comments${r.data.counts.open ? ` (${r.data.counts.open})` : ""}` : "Details"}
                </button>
              ))}
            </div>
            <div className={cn("min-h-0 flex-1 flex-col", r.tab === "comments" ? "flex" : "hidden")}>
              <CommentsPanel
                orgSlug={p.orgSlug}
                versionId={p.version.id}
                versionNumber={p.version.number}
                data={r.data}
                filter={r.filter}
                onFilter={r.changeFilter}
                selected={r.selected}
                onSelect={p.onSelectThread}
                canComment={p.canComment}
                currentUserId={p.currentUserId}
                position={p.position}
                describe={p.describe}
                monoLabels={p.monoLabels}
                draft={{ count: r.draft.length, label: p.draftLabel, offPosition: p.draftOffPosition }}
                drawingSupported={!!p.onStartDrawing}
                drawing={r.drawing}
                onStartDrawing={() => p.onStartDrawing?.()}
                onClearDraft={r.clearDraft}
                takeDraft={r.takeDraft}
                onPosted={async (threadId) => {
                  r.clearDraft();
                  r.setSelected(threadId);
                  await r.reload();
                }}
                onChanged={() => r.reload()}
                onGoToDraft={p.onGoToDraft}
                emptyHint={p.emptyHint}
                pause={p.pause}
              />
            </div>
            <div className={cn("min-h-0 flex-1 overflow-y-auto", r.tab === "details" ? "block" : "hidden")}>{p.details}</div>
          </aside>
        </>
      )}
    </div>
  );
}

/** Toggle shown in each viewer's toolbar. */
export function PanelToggle({ review, className }: { review: Review; className?: string }) {
  return (
    <IconButton
      label={review.collapsed ? "Show comments panel" : "Hide comments panel"}
      onClick={() => review.setCollapsed(!review.collapsed)}
      className={className}
    >
      {review.collapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
    </IconButton>
  );
}
