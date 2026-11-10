"use client";

import { Eye, EyeOff, Maximize, Minimize, PenLine, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewThread } from "@/server/modules/review";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { AnnotationLayer } from "./annotation-layer";
import { DrawToolbar } from "./draw-toolbar";
import { PanelToggle, ReviewShell } from "./review-shell";
import { savedShapes, useReview, type ReviewData } from "./use-review";

type Props = {
  orgSlug: string;
  version: { id: string; number: number };
  imageUrl: string;
  width: number;
  height: number;
  initial: ReviewData;
  canComment: boolean;
  currentUserId: string;
  details: ReactNode;
};

/**
 * Image review: fit / 100% / zoom (buttons, ⌘/Ctrl + wheel), drag to pan,
 * region comments (draw to mark an area) and vector annotations.
 */
export function ImageViewer({ orgSlug, version, imageUrl, width, height, initial, canComment, currentUserId, details }: Props) {
  const review = useReview({ orgSlug, versionId: version.id, initial });
  const { drawing, annotationsVisible } = review;
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"fit" | number>("fit");
  const [fitScale, setFitScale] = useState(1);
  const [natural, setNatural] = useState({ width: width || 1600, height: height || 1000 });
  const [fullscreen, setFullscreen] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const scale = mode === "fit" ? fitScale : mode;
  const shown = { width: natural.width * scale, height: natural.height * scale };

  const fit = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setFitScale(Math.min(1, (el.clientWidth - 32) / natural.width, (el.clientHeight - 32) / natural.height));
  }, [natural]);
  useLayoutEffect(() => {
    fit();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const zoomBy = (factor: number) => setMode(Math.max(0.05, Math.min(8, Math.round(scale * factor * 100) / 100)));

  const startDrawing = () => canComment && review.startDrawing({ type: "region", region: { x: 0, y: 0, w: 1, h: 1 } });
  const regions = review.data.threads.filter((t) => t.anchor.region);

  const selectThread = (t: ReviewThread) => {
    review.setSelected(t.id);
    const r = t.anchor.region;
    const el = scroller.current;
    if (!r || !el) return;
    el.scrollLeft = r.x * shown.width - el.clientWidth / 2 + (r.w * shown.width) / 2;
    el.scrollTop = r.y * shown.height - el.clientHeight / 2 + (r.h * shown.height) / 2;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest("dialog")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "+":
        case "=":
          zoomBy(1.25);
          break;
        case "-":
          zoomBy(0.8);
          break;
        case "0":
          setMode("fit");
          break;
        case "1":
          setMode(1);
          break;
        case "c":
          e.preventDefault();
          review.focusComposer();
          break;
        case "d":
          if (drawing) review.setDrawing(false);
          else startDrawing();
          break;
        case "a":
          review.setAnnotationsVisible(!annotationsVisible);
          break;
        case "Escape":
          if (drawing) review.setDrawing(false);
          else review.setSelected(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const main = (
    <div ref={box} className="flex min-h-0 flex-1 flex-col bg-[#101013]" data-testid="image-viewer">
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-1 px-2 py-1.5 text-[12px]" role="toolbar" aria-label="Image controls">
        <IconButton label="Fit to view (0)" active={mode === "fit"} onClick={() => setMode("fit")}>
          <Scan size={15} />
        </IconButton>
        <button type="button" onClick={() => setMode(1)} className={cn("rounded px-1.5 py-1", mode === 1 ? "bg-surface-3 text-text" : "text-muted hover:text-text")} aria-label="Actual size (1)">
          100%
        </button>
        <IconButton label="Zoom out (-)" onClick={() => zoomBy(0.8)}>
          <ZoomOut size={15} />
        </IconButton>
        <span className="w-12 text-center text-muted tabular" data-testid="image-zoom">
          {Math.round(scale * 100)}%
        </span>
        <IconButton label="Zoom in (+)" onClick={() => zoomBy(1.25)}>
          <ZoomIn size={15} />
        </IconButton>
        <span className="ml-2 font-mono text-[11px] text-faint">
          {natural.width} × {natural.height}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {canComment && (
            <IconButton label={drawing ? "Stop drawing (d)" : "Mark an area (d)"} active={drawing} onClick={() => (drawing ? review.setDrawing(false) : startDrawing())}>
              <PenLine size={15} />
            </IconButton>
          )}
          <IconButton label={annotationsVisible ? "Hide annotations (a)" : "Show annotations (a)"} active={!annotationsVisible} onClick={() => review.setAnnotationsVisible(!annotationsVisible)}>
            {annotationsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
          </IconButton>
          <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void box.current?.requestFullscreen())}>
            {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </IconButton>
          <PanelToggle review={review} />
        </div>
      </div>
      {drawing && (
        <DrawToolbar
          settings={review.drawSettings}
          onChange={review.setDrawSettings}
          count={review.draft.length}
          onUndo={review.undo}
          onClear={review.clearDraft}
          onDone={() => {
            review.setDrawing(false);
            review.focusComposer();
          }}
        />
      )}
      <div
        ref={scroller}
        className={cn("relative min-h-0 flex-1 overflow-auto", !drawing && "cursor-grab active:cursor-grabbing")}
        data-testid="image-scroll"
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
        }}
        onPointerDown={(e) => {
          if (drawing || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          const el = scroller.current!;
          pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
        }}
        onPointerMove={(e) => {
          if (!pan.current) return;
          const el = scroller.current!;
          el.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
          el.scrollTop = pan.current.top - (e.clientY - pan.current.y);
        }}
        onPointerUp={() => (pan.current = null)}
        onPointerLeave={() => (pan.current = null)}
      >
        <div className="grid min-h-full min-w-full place-items-center p-4">
          <div className="relative shadow-2xl" style={{ width: shown.width, height: shown.height }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL at full resolution */}
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              className="absolute inset-0 size-full select-none"
              style={{ imageRendering: scale >= 2 ? "pixelated" : "auto" }}
              data-testid="review-image"
            />
            {annotationsVisible &&
              regions.map((t) => {
                const r = t.anchor.region!;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Comment area: ${t.comments[0]?.body.slice(0, 40) ?? ""}`}
                    onClick={() => selectThread(t)}
                    className={cn(
                      "absolute rounded-sm border-2 border-dashed transition-colors",
                      review.selected === t.id ? "border-accent bg-accent/10" : t.status === "resolved" ? "border-success/60" : "border-accent/70 hover:bg-accent/10",
                    )}
                    style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, zIndex: 4 }}
                  />
                );
              })}
            <div className="absolute inset-0" style={{ zIndex: 5, pointerEvents: drawing ? "auto" : "none" }}>
              <AnnotationLayer
                size={shown}
                shapes={annotationsVisible ? savedShapes(review.data.threads, () => true) : []}
                draft={annotationsVisible || drawing ? review.draft : []}
                drawing={drawing}
                settings={review.drawSettings}
                onAdd={(shape) => review.addShape(shape, { type: "region", region: { x: 0, y: 0, w: 1, h: 1 } })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <ReviewShell
      review={review}
      orgSlug={orgSlug}
      version={version}
      canComment={canComment}
      currentUserId={currentUserId}
      details={details}
      main={main}
      position={null}
      describe={(t) => (t.anchor.region ? "Area" : null)}
      onSelectThread={selectThread}
      onStartDrawing={canComment ? startDrawing : undefined}
      draftLabel="the image"
      draftOffPosition={false}
      onGoToDraft={() => undefined}
      emptyHint="Draw on the image (D) to comment on an area, or leave a general comment."
    />
  );
}
