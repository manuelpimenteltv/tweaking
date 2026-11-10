"use client";

import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, RotateCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { checkUploadable, formatBytes } from "@/lib/file-types";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";

/**
 * Browser upload engine.
 *  - Files go straight to object storage through presigned multipart URLs.
 *  - Each part is hashed (SHA-256) before upload; the hash is part of the
 *    signature, so storage rejects corrupted parts.
 *  - Failed parts retry with backoff. Interrupted uploads resume: the upload id
 *    is remembered per file and already-stored parts are skipped.
 */

export type UploadTarget = { orgSlug: string; projectId: string; folderId: string | null; assetId?: string | null; label?: string };

type Status = "queued" | "uploading" | "completing" | "done" | "error" | "canceled";

type Item = {
  id: string;
  file: File;
  target: UploadTarget;
  status: Status;
  loaded: number;
  error?: string;
  uploadId?: string;
  assetId?: string;
  bytesPerSec?: number;
};

type Ctx = {
  enqueue: (files: File[], target: UploadTarget) => void;
  maxBytes: number;
};

const UploadCtx = createContext<Ctx | null>(null);

export function useUploader() {
  const ctx = useContext(UploadCtx);
  if (!ctx) throw new Error("useUploader must be used inside UploadProvider");
  return ctx;
}

const FILE_CONCURRENCY = 2;
const PART_CONCURRENCY = 4;
const MAX_PART_RETRIES = 5;
const MAX_BYTES = 500 * 1024 ** 3; // mirrors UPLOAD_MAX_BYTES default; the server is authoritative

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error?.message ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

const resumeKey = (f: File, t: UploadTarget) =>
  `loupe.upload:${t.orgSlug}:${t.projectId}:${t.folderId ?? "root"}:${t.assetId ?? "new"}:${f.name}:${f.size}:${f.lastModified}`;

function store(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage may be unavailable (private mode); resume is best-effort */
  }
}
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function sha256Base64(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s);
}

function putPart(url: string, headers: Record<string, string>, body: Blob, onProgress: (n: number) => void, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else if (xhr.status >= 200 && xhr.status < 300) reject(new Error("Storage didn't expose the ETag header (check bucket CORS)."));
      else reject(new ApiError(xhr.status === 400 ? "Part failed integrity verification." : `Storage rejected the part (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UploadProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = useCallback((id: string, p: Partial<Item>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 400);
  }, [router]);

  const runUpload = useCallback(
    async (item: Item) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      const { file, target } = item;
      const base = `/api/v1/orgs/${encodeURIComponent(target.orgSlug)}/uploads`;
      const key = resumeKey(file, target);
      patch(item.id, { status: "uploading", error: undefined });

      try {
        // 1. Resume an existing session for this exact file, or start one.
        let uploadId = item.uploadId ?? recall(key);
        let partSize = 0;
        let partCount = 0;
        let assetId = item.assetId;
        const done = new Map<number, { etag: string; checksumSha256?: string }>();
        if (uploadId) {
          try {
            const state = await api<{ partSize: number; partCount: number; size: number; parts: { partNumber: number; etag: string; checksumSha256?: string; size?: number }[] }>(
              `${base}/${uploadId}/parts`,
            );
            if (state.size !== file.size) throw new Error("size changed");
            partSize = state.partSize;
            partCount = state.partCount;
            for (const p of state.parts) done.set(p.partNumber, { etag: p.etag, checksumSha256: p.checksumSha256 });
          } catch {
            uploadId = null;
            store(key, null);
          }
        }
        if (!uploadId) {
          const init = await api<{ uploadId: string; assetId: string; partSize: number; partCount: number }>(base, {
            method: "POST",
            body: JSON.stringify({
              projectId: target.projectId,
              folderId: target.folderId,
              assetId: target.assetId ?? null,
              filename: file.name,
              size: file.size,
              mimeType: file.type || "application/octet-stream",
              lastModified: file.lastModified,
            }),
          });
          uploadId = init.uploadId;
          partSize = init.partSize;
          partCount = init.partCount;
          assetId = init.assetId;
          store(key, uploadId);
        }
        patch(item.id, { uploadId, assetId });

        // 2. Upload missing parts with bounded concurrency.
        const progress = new Map<number, number>();
        for (const n of done.keys()) progress.set(n, Math.min(partSize, file.size - (n - 1) * partSize));
        const started = performance.now();
        const resumedBytes = [...progress.values()].reduce((a, b) => a + b, 0);
        const report = () => {
          const loaded = [...progress.values()].reduce((a, b) => a + b, 0);
          const secs = (performance.now() - started) / 1000;
          patch(item.id, { loaded, bytesPerSec: secs > 0.5 ? (loaded - resumedBytes) / secs : undefined });
        };
        report();

        const pending = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
        const uploadOne = async (n: number) => {
          const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
          const checksum = await sha256Base64(blob);
          for (let attempt = 1; ; attempt++) {
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            try {
              const { parts } = await api<{ parts: { url: string; headers: Record<string, string> }[] }>(`${base}/${uploadId}/parts`, {
                method: "POST",
                body: JSON.stringify({ parts: [{ partNumber: n, checksumSha256: checksum }] }),
              });
              const etag = await putPart(parts[0].url, parts[0].headers, blob, (b) => {
                progress.set(n, b);
                report();
              }, controller.signal);
              done.set(n, { etag, checksumSha256: checksum });
              progress.set(n, blob.size);
              report();
              return;
            } catch (err) {
              if ((err as Error).name === "AbortError") throw err;
              const status = (err as ApiError).status;
              // Client errors from our API (permission revoked, expired session) are not retryable.
              if (status && status >= 401 && status < 500 && status !== 408 && status !== 429 && status !== 400) throw err;
              if (attempt >= MAX_PART_RETRIES) throw err;
              progress.set(n, 0);
              report();
              await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
            }
          }
        };
        const queue = [...pending];
        await Promise.all(
          Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
            while (queue.length) await uploadOne(queue.shift()!);
          }),
        );

        // 3. Complete: storage assembles the object; the server verifies size and enqueues processing.
        patch(item.id, { status: "completing" });
        await api(`${base}/${uploadId}/complete`, {
          method: "POST",
          body: JSON.stringify({ parts: [...done.entries()].map(([partNumber, p]) => ({ partNumber, ...p })) }),
        });
        store(key, null);
        patch(item.id, { status: "done", loaded: file.size });
        scheduleRefresh();
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        patch(item.id, { status: "error", error: (err as Error).message });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [patch, scheduleRefresh],
  );

  // Scheduler: keep FILE_CONCURRENCY uploads running.
  useEffect(() => {
    const active = items.filter((i) => i.status === "uploading" || i.status === "completing").length;
    const next = items.filter((i) => i.status === "queued").slice(0, Math.max(0, FILE_CONCURRENCY - active));
    if (!next.length) return;
    // Start on the next tick; a re-render before then cancels and reschedules, so nothing starts twice.
    const t = setTimeout(() => next.forEach((item) => void runUpload(item)), 0);
    return () => clearTimeout(t);
  }, [items, runUpload]);

  // Warn before leaving the page mid-upload.
  useEffect(() => {
    const busy = items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "completing");
    if (!busy) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [items]);

  // Once everything finished cleanly, get out of the way (the tray overlaps page controls).
  useEffect(() => {
    if (!items.length || items.some((i) => i.status !== "done" && i.status !== "canceled")) return;
    const t = setTimeout(() => setItems((l) => l.filter((i) => i.status !== "done" && i.status !== "canceled")), 6000);
    return () => clearTimeout(t);
  }, [items]);

  const enqueue = useCallback((files: File[], target: UploadTarget) => {
    const fresh: Item[] = files.map((file) => {
      const check = checkUploadable(file.name, file.size, MAX_BYTES);
      return {
        id: crypto.randomUUID(),
        file,
        target,
        status: check.ok ? "queued" : "error",
        loaded: 0,
        error: check.ok ? undefined : check.reason,
      };
    });
    setItems((list) => [...list, ...fresh]);
  }, []);

  const cancel = useCallback(
    async (item: Item) => {
      controllers.current.get(item.id)?.abort();
      patch(item.id, { status: "canceled" });
      const key = resumeKey(item.file, item.target);
      const uploadId = item.uploadId ?? recall(key);
      store(key, null);
      if (uploadId) {
        await fetch(`/api/v1/orgs/${encodeURIComponent(item.target.orgSlug)}/uploads/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
        scheduleRefresh();
      }
    },
    [patch, scheduleRefresh],
  );

  const value = useMemo(() => ({ enqueue, maxBytes: MAX_BYTES }), [enqueue]);

  return (
    <UploadCtx.Provider value={value}>
      {children}
      <UploadTray
        items={items}
        onCancel={cancel}
        onRetry={(i) => patch(i.id, { status: "queued", error: undefined })}
        onClear={() => setItems((l) => l.filter((i) => i.status !== "done" && i.status !== "canceled" && !(i.status === "error" && !i.uploadId)))}
      />
    </UploadCtx.Provider>
  );
}

function UploadTray({
  items,
  onCancel,
  onRetry,
  onClear,
}: {
  items: Item[];
  onCancel: (i: Item) => void;
  onRetry: (i: Item) => void;
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length) return null;
  const active = items.filter((i) => i.status === "queued" || i.status === "uploading" || i.status === "completing");
  const total = active.reduce((a, i) => a + i.file.size, 0);
  const loaded = active.reduce((a, i) => a + i.loaded, 0);
  const failed = items.filter((i) => i.status === "error").length;
  const title = active.length
    ? `Uploading ${active.length} file${active.length === 1 ? "" : "s"} · ${total ? Math.floor((loaded / total) * 100) : 0}%`
    : failed
      ? `${failed} upload${failed === 1 ? "" : "s"} need attention`
      : "Uploads complete";

  return (
    <section
      aria-label="Uploads"
      className="fixed right-4 bottom-4 z-40 w-[360px] overflow-hidden rounded-lg bg-surface-2"
      style={{ boxShadow: "var(--shadow)" }}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="flex-1 text-[12px] font-medium" aria-live="polite">
          {title}
        </p>
        {!active.length && (
          <button type="button" onClick={onClear} className="text-[12px] text-muted hover:text-text">
            Clear
          </button>
        )}
        <IconButton label={collapsed ? "Expand uploads" : "Collapse uploads"} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </IconButton>
      </header>
      {!collapsed && (
        <ul className="max-h-72 overflow-y-auto">
          {items
            .slice()
            .reverse()
            .map((i) => (
              <li key={i.id} className="border-b border-border px-3 py-2 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px]" title={i.file.name}>
                    {i.file.name}
                  </span>
                  {i.status === "done" && <CircleCheck size={14} className="text-success" aria-label="Uploaded" />}
                  {i.status === "error" && <CircleAlert size={14} className="text-danger" aria-label="Failed" />}
                  {i.status === "error" && (i.uploadId || i.error === "Network error" || i.error?.includes("integrity")) && (
                    <IconButton label="Retry upload" onClick={() => onRetry(i)}>
                      <RotateCw size={13} />
                    </IconButton>
                  )}
                  {(i.status === "queued" || i.status === "uploading" || i.status === "error") && (
                    <IconButton label="Cancel upload" onClick={() => onCancel(i)}>
                      <X size={13} />
                    </IconButton>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-faint">
                  <span className="tabular">
                    {i.status === "error" ? (
                      <span className="text-danger">{i.error}</span>
                    ) : i.status === "done" ? (
                      `${formatBytes(i.file.size)} · uploaded`
                    ) : i.status === "canceled" ? (
                      "Canceled"
                    ) : i.status === "completing" ? (
                      "Finalizing…"
                    ) : i.status === "queued" ? (
                      `Queued · ${formatBytes(i.file.size)}`
                    ) : (
                      `${formatBytes(i.loaded)} of ${formatBytes(i.file.size)}${i.bytesPerSec ? ` · ${formatBytes(i.bytesPerSec)}/s` : ""}`
                    )}
                  </span>
                  <span className="ml-auto truncate">{i.target.label}</span>
                </div>
                {(i.status === "uploading" || i.status === "completing") && (
                  <Progress className={cn("mt-1.5")} value={(i.loaded / Math.max(1, i.file.size)) * 100} />
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
