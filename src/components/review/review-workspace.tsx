"use client";

import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Keyboard,
  Maximize,
  Minimize,
  MessageSquare,
  Pause,
  PanelRightClose,
  PanelRightOpen,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { listThreadsAction } from "@/server/actions/review";
import type { AnnotationShape } from "@/server/db/schema";
import type { ReviewThread } from "@/server/modules/review";
import type { ThreadFilter } from "@/lib/review";
import { frameToSeekTime, frameToTimecode, secondsToFrame, type Fps } from "@/lib/timecode";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { AnnotationLayer, type DrawSettings } from "./annotation-layer";
import { CommentsPanel, type ComposerApi } from "./comments-panel";
import { DrawToolbar } from "./draw-toolbar";

export type Rendition = { name: string; url: string };
export type Sprite = { url: string; interval: number; count: number; columns: number; rows: number; tileWidth: number; tileHeight: number };

type Props = {
  orgSlug: string;
  version: { id: string; number: number; isCurrent: boolean };
  media: {
    fps: Fps;
    startTimecode: string | null;
    durationSec: number;
    width: number;
    height: number;
    renditions: Rendition[];
    posterUrl: string | null;
    sprite: Sprite | null;
  };
  initial: { threads: ReviewThread[]; counts: { open: number; resolved: number }; otherVersions: { versionNumber: number; open: number; total: number }[] };
  canComment: boolean;
  currentUserId: string;
  details: ReactNode;
};

const RATES = [0.25, 0.5, 1, 1.5, 2];
const PANEL_MIN = 300;
const PANEL_DEFAULT = 380;

/** Per-browser UI preference (panel width, collapsed, annotation visibility). Server render uses the default. */
const STORE_EVENT = "loupe-preference";
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function useStoredState<T>(key: string, initial: T) {
  const raw = useSyncExternalStore(
    (notify) => {
      window.addEventListener(STORE_EVENT, notify);
      window.addEventListener("storage", notify);
      return () => {
        window.removeEventListener(STORE_EVENT, notify);
        window.removeEventListener("storage", notify);
      };
    },
    () => readStored(key),
    () => null,
  );
  const [fallback, setFallback] = useState<T>(initial);
  let value = fallback;
  if (raw != null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      /* corrupt value: use default */
    }
  }
  const set = useCallback(
    (v: T) => {
      setFallback(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable: in-memory only */
      }
      window.dispatchEvent(new Event(STORE_EVENT));
    },
    [key],
  );
  return [value, set] as const;
}

export function ReviewWorkspace({ orgSlug, version, media, initial, canComment, currentUserId, details }: Props) {
  const { fps, durationSec } = media;
  const totalFrames = Math.max(1, Math.round((durationSec * fps.num) / fps.den));
  const toast = useToast();

  // ── Player state ───────────────────────────────────────────────────────
  const video = useRef<HTMLVideoElement>(null);
  const playerBox = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [frame, setFrameState] = useState(0);
  // Source of truth for stepping: updated synchronously so rapid key presses never lose frames.
  const frameRef = useRef(0);
  const setFrame = useCallback((f: number) => {
    frameRef.current = f;
    setFrameState(f);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [renditionIdx, setRenditionIdx] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showTc, setShowTc] = useState<"tc" | "frames">("tc");
  const [picture, setPicture] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [help, setHelp] = useState(false);
  const [annotationsVisible, setAnnotationsVisible] = useStoredState("loupe.review.annotations", true);

  // ── Review state ───────────────────────────────────────────────────────
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<ThreadFilter>({ status: "all", sort: "timecode" });
  const [selected, setSelected] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<AnnotationShape[]>([]);
  const [draftFrame, setDraftFrame] = useState<number | null>(null);
  const [draw, setDraw] = useState<DrawSettings>({ tool: "arrow", color: "#F2A93B", width: 4 });
  const composer = useRef<ComposerApi>(null);

  // ── Panel layout (resizable + collapsible, remembered per browser) ─────
  const [panelWidth, setPanelWidth] = useStoredState("loupe.review.panelWidth", PANEL_DEFAULT);
  const [collapsed, setCollapsed] = useStoredState("loupe.review.panelCollapsed", false);
  const [tab, setTab] = useState<"comments" | "details">("comments");

  const source = media.renditions[renditionIdx] ?? media.renditions[0];
  const tc = (f: number) => (showTc === "tc" ? frameToTimecode(f, fps, media.startTimecode) : String(f));

  // Track the frame actually on screen (requestVideoFrameCallback reports the presented frame's media time).
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let handle = 0;
    const rvfc = typeof (v as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      // Only trust presented frames during playback; while paused, frames from earlier
      // in-flight seeks would overwrite the frame the user just stepped to.
      if (!v.paused) setFrame(Math.min(totalFrames - 1, secondsToFrame(meta.mediaTime, fps)));
      handle = v.requestVideoFrameCallback(onFrame);
    };
    if (rvfc) handle = v.requestVideoFrameCallback(onFrame);
    const sync = () => setFrame(Math.min(totalFrames - 1, secondsToFrame(v.currentTime, fps)));
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      sync();
    };
    v.addEventListener("seeked", sync);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    if (!rvfc) v.addEventListener("timeupdate", sync);
    return () => {
      if (rvfc) v.cancelVideoFrameCallback(handle);
      v.removeEventListener("seeked", sync);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("timeupdate", sync);
    };
  }, [fps, totalFrames, source?.url, setFrame]);

  // Fit the overlay exactly over the displayed picture (object-fit: contain), at any size.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const v = video.current;
      const iw = v?.videoWidth || media.width;
      const ih = v?.videoHeight || media.height;
      const { width: sw, height: sh } = el.getBoundingClientRect();
      const scale = Math.min(sw / iw, sh / ih);
      const w = iw * scale;
      const h = ih * scale;
      setPicture({ left: (sw - w) / 2, top: (sh - h) / 2, width: w, height: h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    video.current?.addEventListener("loadedmetadata", fit);
    const v = video.current;
    return () => {
      ro.disconnect();
      v?.removeEventListener("loadedmetadata", fit);
    };
  }, [media.width, media.height, collapsed, panelWidth]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === playerBox.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const seekFrame = useCallback(
    (f: number) => {
      const v = video.current;
      if (!v) return;
      const clamped = Math.max(0, Math.min(totalFrames - 1, Math.round(f)));
      v.pause();
      v.currentTime = frameToSeekTime(clamped, fps);
      setFrame(clamped);
    },
    [fps, totalFrames, setFrame],
  );
  const step = useCallback((delta: number) => seekFrame(frameRef.current + delta), [seekFrame]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      setDrawing(false);
      if (frame >= totalFrames - 1) v.currentTime = 0;
      void v.play();
    } else v.pause();
  }, [frame, totalFrames]);

  const switchRendition = (idx: number) => {
    const v = video.current;
    if (!v || idx === renditionIdx) return;
    const at = frame;
    const wasPlaying = !v.paused;
    setRenditionIdx(idx);
    v.addEventListener(
      "loadedmetadata",
      () => {
        v.currentTime = frameToSeekTime(at, fps);
        v.playbackRate = rate;
        if (wasPlaying) void v.play();
      },
      { once: true },
    );
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playerBox.current?.requestFullscreen();
  };

  // ── Threads ────────────────────────────────────────────────────────────
  const reload = useCallback(
    async (f: ThreadFilter = filter) => {
      const res = await listThreadsAction(orgSlug, version.id, f);
      if (res.ok) setData(res.data);
      else toast(res.error.message, "error");
    },
    [filter, orgSlug, toast, version.id],
  );

  const changeFilter = (f: ThreadFilter) => {
    setFilter(f);
    void reload(f);
  };

  // Pick up teammates' comments without a reload.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const selectThread = (t: ReviewThread) => {
    setSelected(t.id);
    if (t.frame != null) seekFrame(t.frame);
  };

  const startDrawing = () => {
    if (!canComment) return;
    video.current?.pause();
    setDrawing(true);
    setDraftFrame((f) => f ?? frame);
    setAnnotationsVisible(true);
  };

  // Saved drawings are frame-specific: show them while paused on their frame.
  const visibleShapes = useMemo(() => {
    if (!annotationsVisible || playing) return [];
    return data.threads.flatMap((t) =>
      t.comments.flatMap((c) => (c.annotation && c.annotation.frame === frame ? c.annotation.shapes : [])),
    );
  }, [annotationsVisible, playing, data.threads, frame]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest("dialog")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = video.current;
      const second = Math.round(fps.num / fps.den);
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-(e.shiftKey ? second : 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          step(e.shiftKey ? second : 1);
          break;
        case "j":
          step(-second * 5);
          break;
        case "l":
          if (v) {
            const next = v.paused ? 1 : Math.min(2, v.playbackRate * 2);
            v.playbackRate = next;
            setRate(next);
            if (v.paused) void v.play();
          }
          break;
        case "Home":
          seekFrame(0);
          break;
        case "End":
          seekFrame(totalFrames - 1);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          if (v) {
            v.muted = !v.muted;
            setMuted(v.muted);
          }
          break;
        case "a":
          setAnnotationsVisible(!annotationsVisible);
          break;
        case "d":
          if (drawing) setDrawing(false);
          else startDrawing();
          break;
        case "c":
          e.preventDefault();
          v?.pause();
          setCollapsed(false);
          setTab("comments");
          setTimeout(() => composer.current?.focus(), 0);
          break;
        case "Escape":
          if (drawing) setDrawing(false);
          else setSelected(null);
          break;
        case "?":
          setHelp((h) => !h);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Panel resize ───────────────────────────────────────────────────────
  const clampWidth = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, Math.max(PANEL_MIN, window.innerWidth * 0.6))));
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev: PointerEvent) => setPanelWidth(clampWidth(startW - (ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const markers = data.threads.filter((t) => t.frame != null);

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── Primary: player ── */}
      <div ref={playerBox} className="flex min-w-0 flex-1 flex-col bg-[#060607]" data-testid="player">
        {drawing && (
          <DrawToolbar
            settings={draw}
            onChange={setDraw}
            count={draft.length}
            onUndo={() => setDraft((d) => d.slice(0, -1))}
            onClear={() => {
              setDraft([]);
              setDraftFrame(null);
            }}
            onDone={() => {
              setDrawing(false);
              setTimeout(() => composer.current?.focus(), 0);
            }}
          />
        )}
        <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden" onDoubleClick={toggleFullscreen}>
          {source ? (
            <video
              ref={video}
              src={source.url}
              poster={media.posterUrl ?? undefined}
              preload="auto"
              playsInline
              className="absolute inset-0 size-full object-contain"
              onClick={() => !drawing && togglePlay()}
              aria-label="Review player"
              data-testid="review-video"
            />
          ) : null}
          <div className="absolute" style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}>
            <AnnotationLayer
              size={{ width: picture.width, height: picture.height }}
              shapes={visibleShapes}
              draft={annotationsVisible || drawing ? (draftFrame == null || draftFrame === frame ? draft : []) : []}
              drawing={drawing}
              settings={draw}
              onAdd={(s) => {
                setDraft((d) => [...d, s]);
                setDraftFrame((f) => f ?? frame);
              }}
            />
          </div>
          {help && <ShortcutHelp onClose={() => setHelp(false)} />}
        </div>

        <Timeline
          totalFrames={totalFrames}
          frame={frame}
          fps={fps}
          sprite={media.sprite}
          markers={markers}
          selected={selected}
          tc={tc}
          onSeek={seekFrame}
          onMarker={selectThread}
        />

        {/* Transport */}
        <div className="flex flex-wrap items-center gap-1 border-t border-white/5 px-3 py-2 text-white/80">
          <IconButton label={playing ? "Pause (space)" : "Play (space)"} onClick={togglePlay} className="text-white hover:bg-white/10">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton label="Previous frame (←)" onClick={() => step(-1)} className="text-white/80 hover:bg-white/10">
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton label="Next frame (→)" onClick={() => step(1)} className="text-white/80 hover:bg-white/10">
            <ChevronRight size={16} />
          </IconButton>
          <IconButton label="Back 1 second (shift ←)" onClick={() => step(-Math.round(fps.num / fps.den))} className="text-white/80 hover:bg-white/10">
            <SkipBack size={14} />
          </IconButton>
          <IconButton label="Forward 1 second (shift →)" onClick={() => step(Math.round(fps.num / fps.den))} className="text-white/80 hover:bg-white/10">
            <SkipForward size={14} />
          </IconButton>
          <button
            type="button"
            onClick={() => setShowTc(showTc === "tc" ? "frames" : "tc")}
            title="Toggle timecode / frame number"
            className="ml-2 rounded px-1.5 py-0.5 font-mono text-[13px] text-white tabular hover:bg-white/10"
            data-testid="timecode"
          >
            {tc(frame)}
          </button>
          <span className="font-mono text-[12px] text-white/40 tabular">/ {tc(totalFrames - 1)}</span>
          <span className="ml-2 font-mono text-[11px] text-white/40">{(fps.num / fps.den).toFixed(3).replace(/\.?0+$/, "")} fps</span>

          <div className="ml-auto flex items-center gap-1">
            {canComment && (
              <IconButton
                label={drawing ? "Stop drawing (d)" : "Draw on frame (d)"}
                active={drawing}
                onClick={() => (drawing ? setDrawing(false) : startDrawing())}
                className="text-white/80 hover:bg-white/10"
              >
                <PencilIcon />
              </IconButton>
            )}
            <IconButton
              label={annotationsVisible ? "Hide annotations (a)" : "Show annotations (a)"}
              active={!annotationsVisible}
              onClick={() => setAnnotationsVisible(!annotationsVisible)}
              className="text-white/80 hover:bg-white/10"
            >
              {annotationsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
            </IconButton>
            <IconButton
              label={muted ? "Unmute (m)" : "Mute (m)"}
              onClick={() => {
                if (!video.current) return;
                video.current.muted = !muted;
                setMuted(!muted);
              }}
              className="text-white/80 hover:bg-white/10"
            >
              {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              className="w-20 accent-[var(--accent)]"
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                if (video.current) {
                  video.current.volume = v;
                  video.current.muted = v === 0;
                }
                setMuted(v === 0);
              }}
            />
            <select
              aria-label="Playback speed"
              value={rate}
              onChange={(e) => {
                const r = Number(e.target.value);
                setRate(r);
                if (video.current) video.current.playbackRate = r;
              }}
              className="h-7 rounded bg-white/5 px-1.5 text-[12px] text-white/80"
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            {media.renditions.length > 1 && (
              <select
                aria-label="Resolution"
                value={renditionIdx}
                onChange={(e) => switchRendition(Number(e.target.value))}
                className="h-7 rounded bg-white/5 px-1.5 text-[12px] text-white/80"
              >
                {media.renditions.map((r, i) => (
                  <option key={r.name} value={i}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            <IconButton label="Keyboard shortcuts (?)" onClick={() => setHelp((h) => !h)} className="text-white/80 hover:bg-white/10">
              <Keyboard size={15} />
            </IconButton>
            <IconButton label={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"} onClick={toggleFullscreen} className="text-white/80 hover:bg-white/10">
              {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
            </IconButton>
            <IconButton
              label={collapsed ? "Show comments panel" : "Hide comments panel"}
              onClick={() => setCollapsed(!collapsed)}
              className="text-white/80 hover:bg-white/10"
            >
              {collapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            </IconButton>
          </div>
        </div>
      </div>

      {/* ── Secondary: comments & review controls ── */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface-1 pt-3 text-muted hover:text-text"
          aria-label="Show comments panel"
        >
          <MessageSquare size={16} />
          <span className="text-[11px] tabular">{data.counts.open}</span>
        </button>
      ) : (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize comments panel"
            aria-valuenow={panelWidth}
            aria-valuemin={PANEL_MIN}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setPanelWidth(clampWidth(panelWidth + 24));
              if (e.key === "ArrowRight") setPanelWidth(clampWidth(panelWidth - 24));
            }}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent focus-visible:bg-accent"
          />
          <aside className="flex shrink-0 flex-col bg-surface-1" style={{ width: panelWidth }} aria-label="Review panel" data-testid="review-panel">
            <div role="tablist" className="flex gap-4 border-b border-border px-4 pt-2">
              {(["comments", "details"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn("-mb-px border-b-2 pb-2 text-[13px]", tab === t ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}
                >
                  {t === "comments" ? `Comments${data.counts.open ? ` (${data.counts.open})` : ""}` : "Details"}
                </button>
              ))}
            </div>
            <div className={cn("min-h-0 flex-1 flex-col", tab === "comments" ? "flex" : "hidden")}>
              <CommentsPanel
                ref={composer}
                orgSlug={orgSlug}
                versionId={version.id}
                versionNumber={version.number}
                data={data}
                filter={filter}
                onFilter={changeFilter}
                selected={selected}
                onSelect={selectThread}
                canComment={canComment}
                currentUserId={currentUserId}
                frame={frame}
                timecode={frameToTimecode(frame, fps, media.startTimecode)}
                tc={(f) => frameToTimecode(f, fps, media.startTimecode)}
                draft={{ count: draft.length, frame: draftFrame }}
                drawing={drawing}
                onStartDrawing={startDrawing}
                onClearDraft={() => {
                  setDraft([]);
                  setDraftFrame(null);
                  setDrawing(false);
                }}
                takeDraft={() => ({ shapes: draft, frame: draftFrame })}
                onPosted={async (threadId) => {
                  setDraft([]);
                  setDraftFrame(null);
                  setDrawing(false);
                  setSelected(threadId);
                  await reload();
                }}
                onChanged={reload}
                onGoToFrame={seekFrame}
                pause={() => video.current?.pause()}
              />
            </div>
            <div className={cn("min-h-0 flex-1 overflow-y-auto", tab === "details" ? "block" : "hidden")}>{details}</div>
          </aside>
        </>
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function Timeline({
  totalFrames,
  frame,
  fps,
  sprite,
  markers,
  selected,
  tc,
  onSeek,
  onMarker,
}: {
  totalFrames: number;
  frame: number;
  fps: Fps;
  sprite: Sprite | null;
  markers: ReviewThread[];
  selected: string | null;
  tc: (f: number) => string;
  onSeek: (f: number) => void;
  onMarker: (t: ReviewThread) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; width: number; frame: number } | null>(null);
  const toFrame = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { x: frac * r.width, width: r.width, frame: Math.min(totalFrames - 1, Math.floor(frac * totalFrames)) };
  };
  const pct = (f: number) => `${(f / Math.max(1, totalFrames - 1)) * 100}%`;

  const tile = (() => {
    if (!sprite || !hover) return null;
    const sec = (hover.frame * fps.den) / fps.num;
    const idx = Math.min(sprite.count - 1, Math.floor(sec / sprite.interval));
    return { col: idx % sprite.columns, row: Math.floor(idx / sprite.columns) };
  })();

  return (
    <div className="relative px-3 pt-3 pb-1">
      <div
        ref={bar}
        role="slider"
        tabIndex={-1}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={totalFrames - 1}
        aria-valuenow={frame}
        aria-valuetext={tc(frame)}
        className="group relative h-6 cursor-pointer touch-none"
        data-testid="timeline"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(toFrame(e.clientX).frame);
        }}
        onPointerMove={(e) => {
          const p = toFrame(e.clientX);
          setHover(p);
          if (e.buttons === 1) onSeek(p.frame);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full bg-white/15 group-hover:h-1.5" />
        <div className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-accent group-hover:h-1.5" style={{ width: pct(frame) }} />
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: pct(frame) }} />
        {markers.map((t) => (
          <button
            key={t.id}
            type="button"
            title={`${t.timecode ?? ""} — ${t.comments[0]?.body.slice(0, 60) ?? ""}`}
            aria-label={`Comment at ${t.timecode}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onMarker(t)}
            className={cn(
              "absolute -top-1.5 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-[#060607]",
              t.status === "resolved" ? "bg-success/70" : "bg-accent",
              selected === t.id && "scale-150",
            )}
            style={{ left: pct(t.frame!) }}
          />
        ))}
      </div>
      {hover && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 overflow-hidden rounded-md border border-white/10 bg-black"
          style={{ left: Math.max(90, Math.min(hover.x + 12, hover.width - 70)) }}
        >
          {sprite && tile && (
            <div
              style={{
                width: sprite.tileWidth,
                height: sprite.tileHeight,
                backgroundImage: `url(${sprite.url})`,
                backgroundPosition: `-${tile.col * sprite.tileWidth}px -${tile.row * sprite.tileHeight}px`,
                backgroundSize: `${sprite.columns * sprite.tileWidth}px ${sprite.rows * sprite.tileHeight}px`,
              }}
            />
          )}
          <p className="px-1.5 py-0.5 text-center font-mono text-[11px] text-white">{tc(hover.frame)}</p>
        </div>
      )}
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["Space / K", "Play / pause"],
    ["← / →", "Previous / next frame"],
    ["Shift + ← / →", "Back / forward 1 second"],
    ["J / L", "Back 5 s / play faster"],
    ["Home / End", "First / last frame"],
    ["C", "Comment at this frame"],
    ["D", "Draw on this frame"],
    ["A", "Show / hide annotations"],
    ["M", "Mute"],
    ["F", "Fullscreen"],
    ["Esc", "Stop drawing / deselect"],
  ];
  return (
    <div className="absolute top-3 right-3 z-20 w-72 rounded-lg bg-surface-2 p-3 text-[12px]" style={{ boxShadow: "var(--shadow)" }} role="dialog" aria-label="Keyboard shortcuts">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">Keyboard shortcuts</p>
        <button type="button" onClick={onClose} className="text-muted hover:text-text">
          Close
        </button>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <Kbd>{k}</Kbd>
            </dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
