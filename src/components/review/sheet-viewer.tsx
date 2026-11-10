"use client";

import { EyeOff, Maximize, Minimize, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CellStyle, CellTuple, RowTuple, SheetManifest } from "@/server/jobs/sheets";
import type { ReviewThread } from "@/server/modules/review";
import { columnLetters, parseCellRef } from "@/lib/review";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { PanelToggle, ReviewShell } from "./review-shell";
import { useReview, type ReviewData } from "./use-review";

type Props = {
  orgSlug: string;
  version: { id: string; number: number };
  manifest: SheetManifest;
  initial: ReviewData;
  canComment: boolean;
  currentUserId: string;
  details: ReactNode;
};

const ROW_H = 21;
const HEAD_W = 52;
const HEAD_H = 24;
const OVERSCAN = 4;

type Loaded = Map<number, RowTuple>;

/** Index of the last offset ≤ value (offsets ascending). */
function lowerBound(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Spreadsheet review: tabs per sheet, virtualized grid (only visible cells are
 * rendered, rows load in chunks), formula bar, merged cells, hidden rows /
 * columns (toggle), zoom and cell-anchored comments.
 */
export function SheetViewer({ orgSlug, version, manifest, initial, canComment, currentUserId, details }: Props) {
  const review = useReview({ orgSlug, versionId: version.id, initial });
  const firstVisible = Math.max(0, manifest.sheets.findIndex((s) => !s.hidden));
  const [sheetIdx, setSheetIdx] = useState(firstVisible);
  const sheet = manifest.sheets[sheetIdx];
  const [showHidden, setShowHidden] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [rows, setRows] = useState<Record<number, Loaded>>({});
  const requested = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 600 });
  const [fullscreen, setFullscreen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loaded = rows[sheetIdx];

  // ── Geometry ───────────────────────────────────────────────────────────
  const hiddenCols = useMemo(() => new Set(sheet.hiddenCols), [sheet]);
  const colX = useMemo(() => {
    const xs = new Float64Array(sheet.cols + 1);
    for (let c = 0; c < sheet.cols; c++) xs[c + 1] = xs[c] + (hiddenCols.has(c) && !showHidden ? 0 : (sheet.colWidths[c] ?? 72) * zoom);
    return xs;
  }, [sheet, hiddenCols, showHidden, zoom]);
  const rowY = useMemo(() => {
    const ys = new Float64Array(sheet.rows + 1);
    for (let r = 0; r < sheet.rows; r++) {
      const t = loaded?.get(r);
      const hidden = t?.[2] === 1 && !showHidden;
      ys[r + 1] = ys[r] + (hidden ? 0 : (t?.[1] ?? ROW_H) * zoom);
    }
    return ys;
  }, [sheet, loaded, showHidden, zoom]);

  const hiddenRowCount = useMemo(() => (loaded ? [...loaded.values()].filter((r) => r[2] === 1).length : 0), [loaded]);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (el) setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, review.collapsed, review.panelWidth]);

  const r0 = Math.max(0, lowerBound(rowY, view.top) - OVERSCAN);
  const r1 = Math.min(sheet.rows - 1, lowerBound(rowY, view.top + view.height) + OVERSCAN);
  const c0 = Math.max(0, lowerBound(colX, view.left) - 1);
  const c1 = Math.min(sheet.cols - 1, lowerBound(colX, view.left + view.width) + 1);

  // ── Data loading (chunks of rows, on demand) ───────────────────────────
  useEffect(() => {
    const first = Math.floor(r0 / manifest.chunkRows);
    const last = Math.floor(r1 / manifest.chunkRows);
    for (let chunk = first; chunk <= last && chunk < sheet.chunks; chunk++) {
      const key = `${sheetIdx}:${chunk}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      fetch(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/versions/${version.id}/sheets/${sheetIdx}/${chunk}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ rows: RowTuple[] }>;
        })
        .then((data) =>
          setRows((all) => {
            const next = new Map(all[sheetIdx]);
            for (const row of data.rows) next.set(row[0], row);
            return { ...all, [sheetIdx]: next };
          }),
        )
        .catch(() => {
          requested.current.delete(key);
          setLoadError("Some rows couldn't be loaded. Scroll again to retry.");
        });
    }
  }, [r0, r1, sheetIdx, sheet.chunks, manifest.chunkRows, orgSlug, version.id]);

  // ── Merges ─────────────────────────────────────────────────────────────
  const merges = useMemo(
    () =>
      sheet.merges
        .map((m) => {
          const [a, b] = m.split(":");
          const s = parseCellRef(a);
          const e = parseCellRef(b ?? a);
          return s && e ? { r0: s.row, c0: s.col, r1: e.row, c1: e.col } : null;
        })
        .filter((m): m is { r0: number; c0: number; r1: number; c1: number } => !!m),
    [sheet],
  );
  const coveredBy = useCallback(
    (r: number, c: number) => merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) ?? null,
    [merges],
  );

  // ── Comments ───────────────────────────────────────────────────────────
  const commentCells = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of review.data.threads) {
      if (t.anchor.sheet !== sheet.name || t.anchor.row == null || t.anchor.col == null) continue;
      const k = `${t.anchor.row}:${t.anchor.col}`;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [review.data.threads, sheet.name]);
  const sheetCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of review.data.threads) if (t.anchor.sheet) m.set(t.anchor.sheet, (m.get(t.anchor.sheet) ?? 0) + 1);
    return m;
  }, [review.data.threads]);

  const scrollToCell = useCallback(
    (row: number, col: number) => {
      const el = scroller.current;
      if (!el) return;
      const top = rowY[row];
      const left = colX[col];
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - HEAD_H - 40) el.scrollTop = Math.max(0, top - 60);
      if (left < el.scrollLeft || left > el.scrollLeft + el.clientWidth - HEAD_W - 80) el.scrollLeft = Math.max(0, left - 60);
    },
    [rowY, colX],
  );

  const selectThread = (t: ReviewThread) => {
    review.setSelected(t.id);
    if (t.anchor.sheet == null || t.anchor.row == null || t.anchor.col == null) return;
    const idx = manifest.sheets.findIndex((s) => s.name === t.anchor.sheet);
    if (idx < 0) return;
    setSheetIdx(idx);
    setSel({ row: t.anchor.row, col: t.anchor.col });
    // Scroll after the sheet switch has laid out.
    setTimeout(() => scrollToCell(t.anchor.row!, t.anchor.col!), 50);
  };

  const cellAt = (r: number, c: number): CellTuple | undefined => loaded?.get(r)?.[3].find((x) => x[0] === c);
  const selCell = sel ? cellAt(sel.row, sel.col) : undefined;
  const selRef = sel ? `${columnLetters(sel.col)}${sel.row + 1}` : null;

  const moveSel = (dr: number, dc: number) => {
    setSel((s) => {
      const base = s ?? { row: 0, col: 0 };
      const next = { row: Math.max(0, Math.min(sheet.rows - 1, base.row + dr)), col: Math.max(0, Math.min(sheet.cols - 1, base.col + dc)) };
      setTimeout(() => scrollToCell(next.row, next.col), 0);
      return next;
    });
  };

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const switchSheet = (i: number) => {
    setSheetIdx(i);
    setSel(null);
    if (scroller.current) {
      scroller.current.scrollTop = 0;
      scroller.current.scrollLeft = 0;
    }
  };

  // ── Render visible cells ───────────────────────────────────────────────
  const cells: ReactNode[] = [];
  const drawnMerges = new Set<string>();
  for (let r = r0; r <= r1; r++) {
    const h = rowY[r + 1] - rowY[r];
    if (h <= 0) continue;
    for (let c = c0; c <= c1; c++) {
      const w = colX[c + 1] - colX[c];
      if (w <= 0) continue;
      const merge = coveredBy(r, c);
      let x = colX[c];
      let y = rowY[r];
      let width = w;
      let height = h;
      let rr = r;
      let cc = c;
      if (merge) {
        const k = `${merge.r0}:${merge.c0}`;
        if (drawnMerges.has(k)) continue;
        drawnMerges.add(k);
        rr = merge.r0;
        cc = merge.c0;
        x = colX[merge.c0];
        y = rowY[merge.r0];
        width = colX[merge.c1 + 1] - x;
        height = rowY[merge.r1 + 1] - y;
      }
      const cell = cellAt(rr, cc);
      const style: CellStyle | undefined = cell?.[3] != null ? sheet.styles[cell[3]] : undefined;
      const isSel = sel?.row === rr && sel?.col === cc;
      const threads = commentCells.get(`${rr}:${cc}`);
      const align = style?.align ?? (cell?.[4] === "n" || cell?.[4] === "d" ? "right" : cell?.[4] === "b" || cell?.[4] === "e" ? "center" : "left");
      cells.push(
        <div
          key={`${rr}:${cc}`}
          role="gridcell"
          aria-selected={isSel}
          data-cell={`${columnLetters(cc)}${rr + 1}`}
          onMouseDown={() => setSel({ row: rr, col: cc })}
          className={cn(
            "absolute overflow-hidden border-r border-b border-[#e3e3e6] px-1 text-[#1b1b1f] select-none",
            style?.wrap ? "leading-tight break-words whitespace-normal" : "whitespace-nowrap",
            isSel && "z-10 outline-2 -outline-offset-1 outline-accent",
          )}
          style={{
            left: x,
            top: y,
            width,
            height,
            lineHeight: style?.wrap ? undefined : `${height - 1}px`,
            fontSize: (style?.size ? (style.size * 4) / 3 : 13) * zoom,
            fontWeight: style?.b ? 600 : undefined,
            fontStyle: style?.i ? "italic" : undefined,
            textDecoration: style?.u ? "underline" : undefined,
            color: style?.color,
            background: style?.bg ?? (merge ? "#fff" : undefined),
            textAlign: align,
          }}
        >
          {cell?.[1]}
          {threads && (
            <svg
              aria-label={`${threads.length} comment${threads.length === 1 ? "" : "s"}`}
              role="img"
              width={8}
              height={8}
              viewBox="0 0 8 8"
              className="absolute top-0 right-0"
            >
              <path d="M0 0H8V8Z" fill={threads.some((t) => t.status === "open") ? "var(--accent)" : "var(--success)"} />
            </svg>
          )}
        </div>,
      );
    }
  }

  const totalW = colX[sheet.cols];
  const totalH = rowY[sheet.rows];

  const main = (
    <div ref={box} className="flex min-h-0 flex-1 flex-col bg-surface-1" data-testid="sheet-viewer">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[12px]" role="toolbar" aria-label="Spreadsheet controls">
        <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}>
          <ZoomOut size={15} />
        </IconButton>
        <span className="w-10 text-center text-muted tabular">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))}>
          <ZoomIn size={15} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[var(--accent)]" />
          Show hidden rows & columns
          {(sheet.hiddenCols.length > 0 || hiddenRowCount > 0) && (
            <span className="text-faint">
              ({sheet.hiddenCols.length} col{sheet.hiddenCols.length === 1 ? "" : "s"}
              {hiddenRowCount ? `, ${hiddenRowCount} row${hiddenRowCount === 1 ? "" : "s"}` : ""})
            </span>
          )}
        </label>
        {sheet.truncated && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-warning">Preview limited to the first {sheet.rows.toLocaleString("en")} rows</span>}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void box.current?.requestFullscreen())}>
            {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </IconButton>
          <PanelToggle review={review} />
        </div>
      </div>

      {/* Formula bar */}
      <div className="flex h-8 items-center border-b border-border text-[12px]" data-testid="formula-bar">
        <span className="w-24 shrink-0 border-r border-border px-2 font-mono text-muted" aria-label="Selected cell">
          {selRef ?? "—"}
        </span>
        <span className="px-2 font-mono text-faint italic">fx</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text" data-testid="formula">
          {selCell ? (selCell[2] ?? selCell[1]) : ""}
        </span>
        {selCell?.[2] && <span className="shrink-0 px-2 text-faint">shows {selCell[1] || "(empty)"}</span>}
      </div>

      {/* Grid */}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-white outline-none"
        tabIndex={0}
        role="grid"
        aria-label={`Sheet ${sheet.name}`}
        aria-rowcount={sheet.rows}
        aria-colcount={sheet.cols}
        onScroll={measure}
        onKeyDown={(e) => {
          const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, 1] };
          if (moves[e.key]) {
            e.preventDefault();
            moveSel(...moves[e.key]);
          } else if (e.key === "c" && sel && canComment) {
            e.preventDefault();
            review.focusComposer();
          }
        }}
        data-testid="sheet-grid"
      >
        <div style={{ width: totalW + HEAD_W, height: totalH + HEAD_H, position: "relative" }}>
          {/* Column headers */}
          <div className="sticky top-0 z-20 flex" style={{ height: HEAD_H, width: totalW + HEAD_W }}>
            <div className="sticky left-0 z-30 shrink-0 border-r border-b border-[#d4d4d8] bg-[#f1f1f3]" style={{ width: HEAD_W, height: HEAD_H }} />
            <div className="relative" style={{ width: totalW, height: HEAD_H }}>
              {Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i).map((c) => {
                const w = colX[c + 1] - colX[c];
                if (w <= 0) return null;
                return (
                  <div
                    key={c}
                    className={cn(
                      "absolute border-r border-b border-[#d4d4d8] bg-[#f1f1f3] text-center text-[11px] leading-6 text-[#52525b]",
                      sel?.col === c && "bg-accent-soft font-semibold text-[#1b1b1f]",
                      hiddenCols.has(c) && "italic text-[#a1a1aa]",
                    )}
                    style={{ left: colX[c], width: w, height: HEAD_H }}
                  >
                    {columnLetters(c)}
                  </div>
                );
              })}
            </div>
          </div>
          {/* Row headers */}
          <div className="absolute z-10" style={{ width: HEAD_W, height: totalH, top: HEAD_H, left: view.left }}>
            {Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map((r) => {
              const h = rowY[r + 1] - rowY[r];
              if (h <= 0) return null;
              return (
                <div
                  key={r}
                  className={cn(
                    "absolute w-full border-r border-b border-[#d4d4d8] bg-[#f1f1f3] text-center text-[11px] text-[#52525b]",
                    sel?.row === r && "bg-accent-soft font-semibold text-[#1b1b1f]",
                    loaded?.get(r)?.[2] === 1 && "italic text-[#a1a1aa]",
                  )}
                  style={{ top: rowY[r], height: h, lineHeight: `${h}px` }}
                >
                  {r + 1}
                </div>
              );
            })}
          </div>
          {/* Cells */}
          <div className="absolute" style={{ left: HEAD_W, top: HEAD_H, width: totalW, height: totalH }}>
            {cells}
          </div>
        </div>
      </div>
      {loadError && <p className="border-t border-border bg-warning-soft px-3 py-1 text-[12px] text-warning">{loadError}</p>}

      {/* Sheet tabs */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-t border-border bg-surface-1 px-2 py-1" role="tablist" aria-label="Sheets">
        {manifest.sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="tab"
            aria-selected={i === sheetIdx}
            onClick={() => switchSheet(i)}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-[12px]",
              i === sheetIdx ? "bg-surface-3 text-text" : "text-muted hover:text-text",
              s.hidden && "italic",
            )}
            title={s.hidden ? "Hidden sheet in the original workbook" : undefined}
          >
            {s.hidden && <EyeOff size={11} aria-label="Hidden sheet" />}
            {s.name}
            {sheetCounts.get(s.name) ? <span className="rounded bg-accent-soft px-1 text-[10px] text-accent tabular">{sheetCounts.get(s.name)}</span> : null}
          </button>
        ))}
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
      position={selRef ? { label: `${sheet.name}!${selRef}`, anchor: { type: "cell", sheet: sheet.name, cell: selRef } } : null}
      describe={(t) => (t.anchor.cell ? `${t.anchor.sheet}!${t.anchor.cell}` : null)}
      monoLabels
      onSelectThread={selectThread}
      draftLabel={null}
      draftOffPosition={false}
      onGoToDraft={() => undefined}
      emptyHint="Select a cell to comment on it, or leave a general comment."
    />
  );
}
