"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listThreadsAction } from "@/server/actions/review";
import type { AnnotationShape } from "@/server/db/schema";
import type { ReviewThread } from "@/server/modules/review";
import { shapesBounds, type Anchor, type ThreadFilter } from "@/lib/review";
import { useToast } from "@/components/ui/toast";
import type { DrawSettings } from "./annotation-layer";

export type ReviewData = {
  threads: ReviewThread[];
  counts: { open: number; resolved: number };
  otherVersions: { versionNumber: number; open: number; total: number }[];
};

/** Per-browser UI preference (panel width, collapsed, annotation visibility). Server render uses the default. */
const STORE_EVENT = "loupe-preference";
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function useStoredState<T>(key: string, initial: T) {
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

/**
 * State shared by every review viewer (video, documents, spreadsheets, images):
 * threads + filters (with polling), selection, the drawing draft and the panel
 * layout. Viewers only add what is specific to their media.
 */
export function useReview({ orgSlug, versionId, initial }: { orgSlug: string; versionId: string; initial: ReviewData }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<ThreadFilter>({ status: "all", sort: "position" });
  const [selected, setSelected] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<AnnotationShape[]>([]);
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>({ tool: "arrow", color: "#F2A93B", width: 4 });
  const [annotationsVisible, setAnnotationsVisible] = useStoredState("loupe.review.annotations", true);
  const [panelWidth, setPanelWidth] = useStoredState("loupe.review.panelWidth", 380);
  const [collapsed, setCollapsed] = useStoredState("loupe.review.panelCollapsed", false);
  const [tab, setTab] = useState<"comments" | "details">("comments");

  const reload = useCallback(
    async (f: ThreadFilter = filter) => {
      const res = await listThreadsAction(orgSlug, versionId, f);
      if (res.ok) setData(res.data);
      else toast(res.error.message, "error");
    },
    [filter, orgSlug, toast, versionId],
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

  const startDrawing = (anchor: Anchor) => {
    setDrawing(true);
    setDraftAnchor((a) => a ?? anchor);
    setAnnotationsVisible(true);
  };

  const addShape = (shape: AnnotationShape, anchor: Anchor) => {
    setDraft((d) => [...d, shape]);
    setDraftAnchor((a) => a ?? anchor);
  };

  const clearDraft = () => {
    setDraft([]);
    setDraftAnchor(null);
    setDrawing(false);
  };

  /** Shapes + anchor for posting. Page and image anchors get the drawing's bounding box as their region. */
  const takeDraft = (): { shapes: AnnotationShape[]; anchor: Anchor | null } => {
    if (!draft.length || !draftAnchor) return { shapes: [], anchor: null };
    const region = shapesBounds(draft);
    if (draftAnchor.type === "page") return { shapes: draft, anchor: { ...draftAnchor, region } };
    if (draftAnchor.type === "region") return { shapes: draft, anchor: { type: "region", region } };
    return { shapes: draft, anchor: draftAnchor };
  };

  const focusComposer = () => {
    setCollapsed(false);
    setTab("comments");
    // The composer lives in the side panel; focus it once the panel is visible.
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea')?.focus(), 0);
  };

  return {
    data,
    reload,
    filter,
    changeFilter,
    selected,
    setSelected,
    drawing,
    setDrawing,
    draft,
    draftAnchor,
    startDrawing,
    addShape,
    undo: () => setDraft((d) => d.slice(0, -1)),
    clearDraft,
    takeDraft,
    drawSettings,
    setDrawSettings,
    annotationsVisible,
    setAnnotationsVisible,
    panelWidth,
    setPanelWidth,
    collapsed,
    setCollapsed,
    tab,
    setTab,
    focusComposer,
  };
}

export type Review = ReturnType<typeof useReview>;

/** Saved shapes of all loaded threads that match a predicate (e.g. "on frame 48", "on page 3"). */
export function savedShapes(threads: ReviewThread[], match: (a: { frame: number | null; page: number | null }) => boolean): AnnotationShape[] {
  return threads.flatMap((t) => t.comments.flatMap((c) => (c.annotation && match(c.annotation) ? c.annotation.shapes : [])));
}
