"use client";

import "pdfjs-dist/web/pdf_viewer.css";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  PanelLeft,
  PenLine,
  Presentation,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFFindController, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
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
  documentUrl: string;
  pageCount: number;
  /** Presentations use "slide" wording, thumbnails open and a presentation mode. */
  presentation: boolean;
  initial: ReviewData;
  canComment: boolean;
  currentUserId: string;
  details: ReactNode;
};

const ZOOMS: { value: string; label: string }[] = [
  { value: "page-width", label: "Fit width" },
  { value: "page-fit", label: "Fit page" },
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
];

/**
 * PDF / Word / PowerPoint review on PDF.js: lazy page rendering, zoom presets,
 * text layer (selection + search), page thumbnails, presentation mode, and a
 * vector annotation overlay on every page bound to page/region comments.
 */
export function DocumentViewer({ orgSlug, version, documentUrl, pageCount, presentation, initial, canComment, currentUserId, details }: Props) {
  const review = useReview({ orgSlug, versionId: version.id, initial });
  const { drawing, annotationsVisible } = review;
  const noun = presentation ? "Slide" : "Page";

  const box = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewerDiv = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const bus = useRef<EventBus | null>(null);
  const find = useRef<PDFFindController | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState(presentation ? "page-fit" : "page-width");
  const [scalePct, setScalePct] = useState(100);
  const [thumbs, setThumbs] = useState(presentation);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [overlays, setOverlays] = useState<Record<number, HTMLDivElement>>({});
  const overlayEls = useRef<Record<number, HTMLDivElement>>({});

  // ── Load PDF.js and the document ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const v = await import("pdfjs-dist/web/pdf_viewer.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const eventBus = new v.EventBus();
        const linkService = new v.PDFLinkService({ eventBus });
        const findController = new v.PDFFindController({ eventBus, linkService });
        const pdfViewer = new v.PDFViewer({
          container: container.current!,
          viewer: viewerDiv.current!,
          eventBus,
          linkService,
          findController,
          textLayerMode: 1,
          // Links and forms inside documents are not interactive in review (safer, predictable).
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        });
        linkService.setViewer(pdfViewer);
        eventBus.on("pagesinit", () => {
          pdfViewer.currentScaleValue = presentation ? "page-fit" : "page-width";
        });
        eventBus.on("pagechanging", (e: { pageNumber: number }) => {
          setPage(e.pageNumber);
          setPageInput(String(e.pageNumber));
        });
        eventBus.on("scalechanging", (e: { scale: number }) => setScalePct(Math.round(e.scale * 100)));
        eventBus.on("pagerendered", (e: { pageNumber: number; source: { div: HTMLDivElement } }) => {
          // Attach (or re-attach after PDF.js resets the page) our overlay container.
          let el = overlayEls.current[e.pageNumber];
          if (!el) {
            el = document.createElement("div");
            el.className = "loupe-page-overlay";
            el.style.cssText = "position:absolute;inset:0;z-index:5;pointer-events:none";
            overlayEls.current[e.pageNumber] = el;
            setOverlays((o) => ({ ...o, [e.pageNumber]: el! }));
          }
          if (!e.source.div.contains(el)) e.source.div.append(el);
        });
        eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));
        eventBus.on("updatefindcontrolstate", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));
        const loading = pdfjs.getDocument({
          url: documentUrl,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
          iccUrl: "/pdfjs/iccs/",
          enableXfa: false,
        });
        task = loading;
        const loaded = await loading.promise;
        if (cancelled) return;
        pdfViewer.setDocument(loaded);
        linkService.setDocument(loaded);
        viewer.current = pdfViewer;
        bus.current = eventBus;
        find.current = findController;
        setDoc(loaded);
      } catch (err) {
        console.error("[document-viewer]", err);
        if (!cancelled) setError("This document couldn't be displayed. Download the original to view it.");
      }
    })();
    return () => {
      cancelled = true;
      viewer.current?.setDocument(null as never);
      viewer.current = null;
      void task?.destroy();
    };
  }, [documentUrl, presentation]);

  useEffect(() => {
    const onFs = () => {
      const active = document.fullscreenElement === box.current;
      setFullscreen(active);
      if (!active && presenting) {
        setPresenting(false);
        const v = viewer.current;
        if (v) {
          v.scrollMode = 0; // vertical
          v.currentScaleValue = zoom;
        }
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [presenting, zoom]);

  // ── Navigation ─────────────────────────────────────────────────────────
  const goTo = useCallback((n: number, regionY?: number) => {
    const v = viewer.current;
    if (!v) return;
    const target = Math.max(1, Math.min(v.pagesCount, n));
    v.currentPageNumber = target;
    if (regionY != null && container.current) {
      const pageDiv = (v.getPageView(target - 1) as { div: HTMLDivElement }).div;
      container.current.scrollTop = pageDiv.offsetTop + regionY * pageDiv.clientHeight - 80;
    }
  }, []);

  const setScale = (value: string) => {
    setZoom(value);
    if (viewer.current) viewer.current.currentScaleValue = value;
  };
  const stepZoom = (dir: 1 | -1) => {
    const v = viewer.current;
    if (!v) return;
    const next = Math.max(0.25, Math.min(5, Math.round((v.currentScale * (dir > 0 ? 1.2 : 1 / 1.2)) * 100) / 100));
    setZoom(String(next));
    v.currentScaleValue = String(next);
  };

  const runFind = (type: "" | "again", previous = false) => {
    bus.current?.dispatch("find", {
      source: null,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  };
  const present = async () => {
    const v = viewer.current;
    if (!v) return;
    await box.current?.requestFullscreen();
    setPresenting(true);
    v.scrollMode = 3; // one page at a time
    v.currentScaleValue = "page-fit";
  };

  // ── Comments & drawings ────────────────────────────────────────────────
  const draftPage = review.draftAnchor?.type === "page" ? review.draftAnchor.page : null;
  const startDrawing = () => canComment && review.startDrawing({ type: "page", page });
  const selectThread = (t: ReviewThread) => {
    review.setSelected(t.id);
    if (t.page != null) goTo(t.page, t.anchor.region?.y);
  };
  const threadsByPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of review.data.threads) if (t.page != null) m.set(t.page, (m.get(t.page) ?? 0) + 1);
    return m;
  }, [review.data.threads]);

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest("dialog")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = viewer.current;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          if (presenting || e.key === "PageDown") {
            e.preventDefault();
            v?.nextPage();
          }
          break;
        case "ArrowLeft":
        case "PageUp":
          if (presenting || e.key === "PageUp") {
            e.preventDefault();
            v?.previousPage();
          }
          break;
        case "+":
        case "=":
          stepZoom(1);
          break;
        case "-":
          stepZoom(-1);
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
        case "f":
          toggleFullscreen();
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
    <div ref={box} className="flex min-h-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="document-viewer">
      {!presenting && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-1 px-2 py-1.5 text-[12px]" role="toolbar" aria-label="Document controls">
          <IconButton label={thumbs ? `Hide ${noun.toLowerCase()} thumbnails` : `Show ${noun.toLowerCase()} thumbnails`} active={thumbs} onClick={() => setThumbs(!thumbs)}>
            <PanelLeft size={15} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <IconButton label={`Previous ${noun.toLowerCase()}`} onClick={() => viewer.current?.previousPage()} disabled={page <= 1}>
            <ChevronLeft size={15} />
          </IconButton>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goTo(Number(pageInput) || page);
            }}
            className="flex items-center gap-1"
          >
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              aria-label={`${noun} number`}
              className="h-7 w-10 rounded border border-border-strong bg-surface-2 text-center tabular"
              data-testid="page-input"
            />
            <span className="text-muted tabular" data-testid="page-count">
              of {doc?.numPages ?? pageCount}
            </span>
          </form>
          <IconButton label={`Next ${noun.toLowerCase()}`} onClick={() => viewer.current?.nextPage()} disabled={page >= (doc?.numPages ?? pageCount)}>
            <ChevronRight size={15} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <IconButton label="Zoom out (-)" onClick={() => stepZoom(-1)}>
            <ZoomOut size={15} />
          </IconButton>
          <select
            aria-label="Zoom"
            value={ZOOMS.some((z) => z.value === zoom) ? zoom : "custom"}
            onChange={(e) => e.target.value !== "custom" && setScale(e.target.value)}
            className="h-7 rounded border border-border-strong bg-surface-2 px-1"
          >
            {!ZOOMS.some((z) => z.value === zoom) && <option value="custom">{scalePct}%</option>}
            {ZOOMS.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
          <IconButton label="Zoom in (+)" onClick={() => stepZoom(1)}>
            <ZoomIn size={15} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              runFind(matches && matches.total ? "again" : "");
            }}
            className="flex items-center gap-1"
          >
            <label className="flex h-7 items-center gap-1 rounded border border-border-strong bg-surface-2 px-1.5 focus-within:border-accent">
              <Search size={13} className="text-faint" aria-hidden />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMatches(null);
                }}
                placeholder="Find in document"
                aria-label="Find in document"
                className="w-36 bg-transparent outline-none"
              />
            </label>
            {matches && query && (
              <span className="text-muted tabular" data-testid="find-count">
                {matches.total ? `${matches.current} of ${matches.total}` : "No matches"}
              </span>
            )}
            <IconButton label="Previous match" onClick={() => runFind("again", true)} disabled={!query}>
              <ChevronUp size={14} />
            </IconButton>
            <IconButton label="Next match" onClick={() => runFind(matches ? "again" : "")} disabled={!query}>
              <ChevronDown size={14} />
            </IconButton>
          </form>
          <div className="ml-auto flex items-center gap-1">
            {canComment && (
              <IconButton label={drawing ? "Stop drawing (d)" : `Draw on this ${noun.toLowerCase()} (d)`} active={drawing} onClick={() => (drawing ? review.setDrawing(false) : startDrawing())}>
                <PenLine size={15} />
              </IconButton>
            )}
            <IconButton label={annotationsVisible ? "Hide annotations (a)" : "Show annotations (a)"} active={!annotationsVisible} onClick={() => review.setAnnotationsVisible(!annotationsVisible)}>
              {annotationsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
            </IconButton>
            {presentation && (
              <IconButton label="Present slides" onClick={() => void present()}>
                <Presentation size={15} />
              </IconButton>
            )}
            <IconButton label={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
            </IconButton>
            <PanelToggle review={review} />
          </div>
        </div>
      )}
      {drawing && !presenting && (
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
      <div className="flex min-h-0 flex-1">
        {thumbs && doc && !presenting && (
          <Thumbnails doc={doc} current={page} counts={threadsByPage} noun={noun} onSelect={(n) => goTo(n)} />
        )}
        <div className="relative min-w-0 flex-1">
          <div ref={container} className={cn("absolute inset-0 overflow-auto", presenting && "bg-black")} data-testid="pdf-scroll">
            <div ref={viewerDiv} className="pdfViewer" />
          </div>
          {!doc && !error && <p className="absolute inset-0 grid place-items-center text-[13px] text-muted">Loading document…</p>}
          {error && <p className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-danger">{error}</p>}
        </div>
      </div>
      {Object.entries(overlays).map(([n, el]) => {
        const pageNo = Number(n);
        const pageThreads = review.data.threads.filter((t) => t.page === pageNo && t.anchor.region);
        return createPortal(
          <PageOverlay
            key={n}
            host={el}
            shapes={annotationsVisible ? savedShapes(review.data.threads, (a) => a.page === pageNo) : []}
            draft={draftPage === pageNo && (annotationsVisible || drawing) ? review.draft : []}
            drawing={drawing && (draftPage ?? page) === pageNo}
            settings={review.drawSettings}
            onAdd={(shape) => review.addShape(shape, { type: "page", page: pageNo })}
            regions={annotationsVisible ? pageThreads : []}
            selected={review.selected}
            onSelectRegion={selectThread}
          />,
          el,
        );
      })}
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
      position={{ label: `${noun} ${page}`, anchor: { type: "page", page } }}
      describe={(t) => (t.page != null ? `${presentation ? "Slide" : "p."} ${t.page}${t.anchor.region ? " · area" : ""}` : null)}
      onSelectThread={selectThread}
      onStartDrawing={canComment ? startDrawing : undefined}
      draftLabel={draftPage != null ? `${noun.toLowerCase()} ${draftPage}` : null}
      draftOffPosition={draftPage != null && draftPage !== page}
      onGoToDraft={() => draftPage != null && goTo(draftPage)}
      emptyHint={`Comment on the ${noun.toLowerCase()} you're viewing (C), or draw on it (D) to point at an area.`}
    />
  );
}

/** Sized to its page (follows zoom); hosts saved drawings, the draft and clickable comment regions. */
function PageOverlay({
  host,
  shapes,
  draft,
  drawing,
  settings,
  onAdd,
  regions,
  selected,
  onSelectRegion,
}: {
  host: HTMLDivElement;
  shapes: Parameters<typeof AnnotationLayer>[0]["shapes"];
  draft: Parameters<typeof AnnotationLayer>[0]["draft"];
  drawing: boolean;
  settings: Parameters<typeof AnnotationLayer>[0]["settings"];
  onAdd: Parameters<typeof AnnotationLayer>[0]["onAdd"];
  regions: ReviewThread[];
  selected: string | null;
  onSelectRegion: (t: ReviewThread) => void;
}) {
  const [size, setSize] = useState({ width: host.clientWidth, height: host.clientHeight });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);
  return (
    <div className="absolute inset-0" style={{ pointerEvents: drawing ? "auto" : "none" }}>
      {regions.map((t) => {
        const r = t.anchor.region!;
        return (
          <button
            key={t.id}
            type="button"
            aria-label={`Comment area: ${t.comments[0]?.body.slice(0, 40) ?? ""}`}
            onClick={() => onSelectRegion(t)}
            className={cn(
              "absolute rounded-sm border-2 border-dashed transition-colors",
              selected === t.id ? "border-accent bg-accent/10" : t.status === "resolved" ? "border-success/50" : "border-accent/60 hover:bg-accent/10",
            )}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, pointerEvents: "auto" }}
          />
        );
      })}
      <AnnotationLayer size={size} shapes={shapes} draft={draft} drawing={drawing} settings={settings} onAdd={onAdd} />
    </div>
  );
}

/** Lazily rendered page/slide thumbnails with comment counts. */
function Thumbnails({ doc, current, counts, noun, onSelect }: { doc: PDFDocumentProxy; current: number; counts: Map<number, number>; noun: string; onSelect: (n: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <div ref={list} className="w-40 shrink-0 overflow-y-auto border-r border-border bg-surface-1 p-2" aria-label={`${noun} thumbnails`} data-testid="thumbnails">
      {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          data-thumb={n}
          onClick={() => onSelect(n)}
          aria-current={n === current ? "page" : undefined}
          aria-label={`${noun} ${n}`}
          className={cn("relative mb-2 block w-full rounded-md border-2 p-0.5", n === current ? "border-accent" : "border-transparent hover:border-border-strong")}
        >
          <ThumbCanvas doc={doc} page={n} />
          <span className="mt-0.5 flex items-center justify-between px-0.5 text-[11px] text-muted">
            <span className="tabular">{n}</span>
            {counts.get(n) ? <span className="rounded bg-accent-soft px-1 text-accent tabular">{counts.get(n)}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function ThumbCanvas({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    const io = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({ scale: (136 * (window.devicePixelRatio || 1)) / base.width });
        el.width = viewport.width;
        el.height = viewport.height;
        task = p.render({ canvas: el, viewport });
        await task.promise.catch(() => undefined);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      task?.cancel();
    };
  }, [doc, page]);
  return <canvas ref={canvas} className="block h-auto min-h-16 w-full rounded-sm bg-white" />;
}
