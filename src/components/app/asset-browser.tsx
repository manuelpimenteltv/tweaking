"use client";

import {
  ChevronRight,
  Download,
  Ellipsis,
  Folder,
  FolderInput,
  FolderPlus,
  ImageIcon,
  LayoutGrid,
  List,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type DragEvent, type MouseEvent } from "react";
import {
  createFolderAction,
  deleteItemsAction,
  folderTreeAction,
  moveItemsAction,
  renameAssetAction,
  renameFolderAction,
  setCoverAction,
} from "@/server/actions/org";
import { formatBytes, KIND_LABELS } from "@/lib/file-types";
import { duration, PROCESSING_STATUS, REVIEW_STATUS, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { MenuList, type MenuItem } from "@/components/ui/menu";
import { Badge, EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { Thumb } from "./kind-icon";
import { useUploader } from "./uploader";

type FolderItem = { id: string; name: string; itemCount: number; updatedAt: Date | string };
type AssetItem = {
  id: string;
  currentVersionId: string | null;
  name: string;
  kind: string;
  reviewStatus: string;
  versionNumber: number | null;
  versionCount: number;
  extension: string | null;
  sizeBytes: number | null;
  processingStatus: string | null;
  durationSec?: number;
  width?: number;
  height?: number;
  uploaderName: string | null;
  createdAt: string;
  previewUrl: string | null;
};

type Props = {
  orgSlug: string;
  project: { id: string; name: string };
  folder: { id: string; name: string; parentId: string | null } | null;
  breadcrumbs: { id: string; name: string }[];
  folders: FolderItem[];
  assets: AssetItem[];
  permissions: string[];
  view: { sort: string; dir: string; kind: string | null; layout: "grid" | "list" };
};

type Key = `f:${string}` | `a:${string}`;
const DRAG_MIME = "application/x-loupe-items";

type DialogState =
  | { type: "new-folder" }
  | { type: "rename"; key: Key; name: string }
  | { type: "move"; keys: Key[] }
  | { type: "delete"; keys: Key[] }
  | null;

export function AssetBrowser(props: Props) {
  const { orgSlug, project, folder, breadcrumbs, folders, assets, permissions, view } = props;
  const can = useCallback((p: string) => permissions.includes(p), [permissions]);
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useUploader();
  const [selected, setSelected] = useState<Set<Key>>(new Set());
  const [anchor, setAnchor] = useState<Key | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: Key } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();

  const base = `/o/${orgSlug}/projects/${project.id}`;
  const order: Key[] = useMemo(() => [...folders.map((f) => `f:${f.id}` as Key), ...assets.map((a) => `a:${a.id}` as Key)], [folders, assets]);
  const href = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const p = new URLSearchParams();
      const state: Record<string, string | null | undefined> = {
        folder: folder?.id,
        sort: view.sort === "name" ? null : view.sort,
        dir: view.dir === "asc" ? null : view.dir,
        kind: view.kind,
        view: view.layout === "grid" ? null : view.layout,
        ...patch,
      };
      for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
      const s = p.toString();
      return s ? `${base}?${s}` : base;
    },
    [base, folder?.id, view],
  );

  // Poll while files are still uploading/processing so status and thumbnails appear without a reload.
  const busy = assets.some((a) => a.processingStatus === "processing" || a.processingStatus === "awaiting_upload");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [busy, router]);

  const open = useCallback(
    (key: Key) => {
      const id = key.slice(2);
      router.push(key.startsWith("f:") ? href({ folder: id }) : `/o/${orgSlug}/assets/${id}`);
    },
    [href, orgSlug, router],
  );

  const select = (key: Key, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = order.indexOf(anchor);
      const b = order.indexOf(key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(order.slice(lo, hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
      setAnchor(key);
    } else {
      setSelected(new Set([key]));
      setAnchor(key);
    }
  };

  const split = (keys: Iterable<Key>) => {
    const folderIds: string[] = [];
    const assetIds: string[] = [];
    for (const k of keys) (k.startsWith("f:") ? folderIds : assetIds).push(k.slice(2));
    return { folderIds, assetIds };
  };

  const move = useCallback(
    (keys: Key[], targetFolderId: string | null) => {
      const { folderIds, assetIds } = split(keys);
      if (targetFolderId && folderIds.includes(targetFolderId)) return;
      start(async () => {
        const res = await moveItemsAction(orgSlug, { projectId: project.id, folderIds, assetIds, targetFolderId });
        if (res.ok) {
          toast(`Moved ${keys.length} item${keys.length === 1 ? "" : "s"}`, "success");
          setSelected(new Set());
        } else toast(res.error.message, "error");
      });
    },
    [orgSlug, project.id, toast],
  );

  const nameOf = (key: Key) =>
    key.startsWith("f:") ? (folders.find((f) => f.id === key.slice(2))?.name ?? "") : (assets.find((a) => a.id === key.slice(2))?.name ?? "");
  const canDelete = (keys: Iterable<Key>) => {
    const { folderIds, assetIds } = split(keys);
    return (!folderIds.length || can("folder.delete")) && (!assetIds.length || can("asset.delete"));
  };
  const canMove = (keys: Iterable<Key>) => {
    const { folderIds, assetIds } = split(keys);
    return (!folderIds.length || can("folder.edit")) && (!assetIds.length || can("asset.edit"));
  };

  // Keyboard shortcuts: ⌘A select all, Esc clear, Delete/Backspace delete, Enter open, F2 rename.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("dialog")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(order));
      } else if (e.key === "Escape") setSelected(new Set());
      else if ((e.key === "Delete" || e.key === "Backspace") && selected.size && canDelete(selected)) {
        e.preventDefault();
        setDialog({ type: "delete", keys: [...selected] });
      } else if (e.key === "Enter" && selected.size === 1) open([...selected][0]);
      else if (e.key === "F2" && selected.size === 1) {
        const key = [...selected][0];
        setDialog({ type: "rename", key, name: nameOf(key) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Drag & drop ─────────────────────────────────────────────────────────
  const onItemDragStart = (key: Key, e: DragEvent) => {
    if (!canMove([key])) return e.preventDefault();
    const keys = selected.has(key) ? [...selected] : [key];
    if (!selected.has(key)) setSelected(new Set([key]));
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropProps = (targetId: string | null, dropKey: string) => ({
    onDragOver: (e: DragEvent) => {
      const items = e.dataTransfer.types.includes(DRAG_MIME);
      const files = e.dataTransfer.types.includes("Files") && can("asset.upload");
      if (!items && !files) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = items ? "move" : "copy";
      setDropTarget(dropKey);
    },
    onDragLeave: () => setDropTarget((d) => (d === dropKey ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      setFileDrag(false);
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (raw) {
        if (targetId === (folder?.id ?? null)) return;
        move(JSON.parse(raw) as Key[], targetId);
      } else if (e.dataTransfer.files.length && can("asset.upload")) {
        uploadFiles(Array.from(e.dataTransfer.files), targetId);
      }
    },
  });

  const uploadFiles = (files: File[], folderId: string | null) => {
    const label = folderId ? (folders.find((f) => f.id === folderId)?.name ?? folder?.name ?? project.name) : project.name;
    enqueue(files, { orgSlug, projectId: project.id, folderId, label });
  };

  // ── Menus ───────────────────────────────────────────────────────────────
  const itemMenu = (key: Key): MenuItem[] => {
    const isFolder = key.startsWith("f:");
    const id = key.slice(2);
    const keys = selected.has(key) && selected.size > 1 ? [...selected] : [key];
    const multi = keys.length > 1;
    const asset = !isFolder ? assets.find((a) => a.id === id) : undefined;
    const items: MenuItem[] = [];
    if (!multi) items.push({ label: "Open", onSelect: () => open(key), shortcut: "↵" });
    if (!multi && (isFolder ? can("folder.edit") : can("asset.edit")))
      items.push({ label: "Rename", icon: <Pencil size={13} />, shortcut: "F2", onSelect: () => setDialog({ type: "rename", key, name: nameOf(key) }) });
    if (canMove(keys)) items.push({ label: multi ? `Move ${keys.length} items…` : "Move to…", icon: <FolderInput size={13} />, onSelect: () => setDialog({ type: "move", keys }) });
    if (!multi && asset?.currentVersionId && asset.processingStatus !== "awaiting_upload" && can("asset.download"))
      items.push({
        label: "Download original",
        icon: <Download size={13} />,
        onSelect: () => {
          // Full navigation (not client routing): the API answers with a redirect to a signed URL.
          const a = document.createElement("a");
          a.href = `/api/v1/orgs/${orgSlug}/versions/${asset.currentVersionId}/download`;
          a.click();
        },
      });
    if (!multi && asset?.previewUrl && can("project.edit"))
      items.push({
        label: "Use as project cover",
        icon: <ImageIcon size={13} />,
        onSelect: () =>
          start(async () => {
            const res = await setCoverAction(orgSlug, project.id, asset.id);
            toast(res.ok ? "Project cover updated" : res.error.message, res.ok ? "success" : "error");
          }),
      });
    if (canDelete(keys)) {
      items.push({ type: "separator" });
      items.push({ label: multi ? `Delete ${keys.length} items` : "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => setDialog({ type: "delete", keys }) });
    }
    return items;
  };

  const empty = !folders.length && !assets.length;
  const rootDrop = dropProps(folder?.id ?? null, "here");
  const selectedKeys = [...selected];

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files") && can("asset.upload")) setFileDrag(true);
      }}
      {...rootDrop}
      onDragLeave={(e) => {
        rootDrop.onDragLeave();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDrag(false);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelected(new Set());
      }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2">
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-1 text-[13px]">
          <Crumb href={href({ folder: null })} label={project.name} active={!folder} drop={dropProps(null, "crumb:root")} highlight={dropTarget === "crumb:root"} />
          {breadcrumbs.map((b, i) => (
            <span key={b.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={13} className="shrink-0 text-faint" aria-hidden />
              <Crumb
                href={href({ folder: b.id })}
                label={b.name}
                active={i === breadcrumbs.length - 1}
                drop={dropProps(b.id, `crumb:${b.id}`)}
                highlight={dropTarget === `crumb:${b.id}`}
              />
            </span>
          ))}
        </nav>
        <Select
          aria-label="Filter by type"
          className="h-7 w-auto text-[12px]"
          value={view.kind ?? ""}
          onChange={(e) => router.push(href({ kind: e.target.value || null }))}
        >
          <option value="">All types</option>
          {Object.entries(KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Sort"
          className="h-7 w-auto text-[12px]"
          value={`${view.sort}:${view.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":");
            router.push(href({ sort: sort === "name" ? null : sort, dir: dir === "asc" ? null : dir }));
          }}
        >
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="date:desc">Newest first</option>
          <option value="date:asc">Oldest first</option>
          <option value="size:desc">Largest first</option>
          <option value="type:asc">Type</option>
        </Select>
        <div role="group" aria-label="Layout" className="flex rounded-md border border-border p-0.5">
          <IconButton label="Grid view" active={view.layout === "grid"} onClick={() => router.push(href({ view: null }))} className="size-6">
            <LayoutGrid size={13} />
          </IconButton>
          <IconButton label="List view" active={view.layout === "list"} onClick={() => router.push(href({ view: "list" }))} className="size-6">
            <List size={13} />
          </IconButton>
        </div>
        {can("folder.create") && (
          <Button size="sm" onClick={() => setDialog({ type: "new-folder" })}>
            <FolderPlus size={13} /> New folder
          </Button>
        )}
        {can("asset.upload") && (
          <>
            <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()}>
              <Upload size={13} /> Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="upload-input"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(Array.from(e.target.files), folder?.id ?? null);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        // Floats over the content: inserting it in the flow would shift tiles between the clicks of a double-click.
        <div
          className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-surface-3 py-1 pr-1 pl-3 text-[12px]"
          style={{ boxShadow: "var(--shadow)" }}
          role="toolbar"
          aria-label="Selection actions"
        >
          <span className="mr-2 text-muted tabular">{selected.size} selected</span>
          {canMove(selectedKeys) && (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ type: "move", keys: selectedKeys })}>
              <FolderInput size={13} /> Move
            </Button>
          )}
          {canDelete(selectedKeys) && (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ type: "delete", keys: selectedKeys })}>
              <Trash2 size={13} /> Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X size={13} />
          </Button>
        </div>
      )}

      {/* Content */}
      <div className="relative flex-1 overflow-y-auto p-6" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
        {empty ? (
          <EmptyState
            icon={<Upload size={28} />}
            title={folder ? "This folder is empty" : "No files yet"}
            action={
              can("asset.upload") ? (
                <Button variant="primary" onClick={() => fileInput.current?.click()}>
                  <Upload size={14} /> Choose files
                </Button>
              ) : undefined
            }
          >
            {can("asset.upload") ? "Drag files here from your desktop, or choose files to upload." : "Nothing has been shared here yet."}
          </EmptyState>
        ) : view.layout === "grid" ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-3" aria-label="Files and folders">
            {folders.map((f) => {
              const key: Key = `f:${f.id}`;
              return (
                <li key={key}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected.has(key)}
                    draggable
                    onDragStart={(e) => onItemDragStart(key, e)}
                    {...dropProps(f.id, key)}
                    onClick={(e) => select(key, e)}
                    onDoubleClick={() => open(key)}
                    onKeyDown={(e) => e.key === "Enter" && open(key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected.has(key)) setSelected(new Set([key]));
                      setMenu({ x: e.clientX, y: e.clientY, key });
                    }}
                    className={tileClass(selected.has(key), dropTarget === key)}
                  >
                    <div className="flex items-center gap-2.5 p-3">
                      <Folder size={18} className="shrink-0 text-accent" fill="currentColor" fillOpacity={0.15} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{f.name}</span>
                        <span className="block text-[11px] text-faint">{f.itemCount} item{f.itemCount === 1 ? "" : "s"}</span>
                      </span>
                      <MoreButton onOpen={(x, y) => setMenu({ x, y, key })} />
                    </div>
                  </div>
                </li>
              );
            })}
            {assets.map((a) => {
              const key: Key = `a:${a.id}`;
              const proc = a.processingStatus ? PROCESSING_STATUS[a.processingStatus] : null;
              const review = REVIEW_STATUS[a.reviewStatus];
              return (
                <li key={key}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected.has(key)}
                    aria-label={a.name}
                    draggable
                    onDragStart={(e) => onItemDragStart(key, e)}
                    onClick={(e) => select(key, e)}
                    onDoubleClick={() => open(key)}
                    onKeyDown={(e) => e.key === "Enter" && open(key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected.has(key)) setSelected(new Set([key]));
                      setMenu({ x: e.clientX, y: e.clientY, key });
                    }}
                    className={tileClass(selected.has(key), false)}
                  >
                    <div className="relative">
                      <Thumb url={a.previewUrl} kind={a.kind} alt="" className="aspect-video rounded-t-[7px]" />
                      <div className="absolute top-1.5 left-1.5 flex gap-1">
                        {a.versionCount > 1 && <Badge className="bg-black/60 text-white">v{a.versionNumber}</Badge>}
                      </div>
                      {a.durationSec != null && (
                        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{duration(a.durationSec)}</span>
                      )}
                      {proc && a.processingStatus !== "ready" && (
                        <span className="absolute top-1.5 right-1.5">
                          <Badge tone={proc.tone} dot>
                            {proc.label}
                          </Badge>
                        </span>
                      )}
                    </div>
                    <div className="flex items-start gap-1 p-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium" title={a.name}>
                          {a.name}
                        </p>
                        <p className="truncate text-[11px] text-faint">
                          {a.sizeBytes != null ? formatBytes(a.sizeBytes) : "—"}
                          {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                          {a.reviewStatus !== "draft" && review ? ` · ${review.label}` : ""}
                        </p>
                      </div>
                      <MoreButton onOpen={(x, y) => setMenu({ x, y, key })} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <table className="w-full text-left text-[13px]" aria-label="Files and folders">
            <thead className="text-[11px] tracking-wide text-faint uppercase">
              <tr className="border-b border-border">
                <th className="py-2 pl-2 font-medium">Name</th>
                <th className="py-2 font-medium">Type</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Size</th>
                <th className="py-2 font-medium">Uploaded by</th>
                <th className="py-2 text-right font-medium">Added</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => {
                const key: Key = `f:${f.id}`;
                return (
                  <tr
                    key={key}
                    draggable
                    aria-selected={selected.has(key)}
                    onDragStart={(e) => onItemDragStart(key, e)}
                    {...dropProps(f.id, key)}
                    onClick={(e) => select(key, e)}
                    onDoubleClick={() => open(key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, key });
                    }}
                    className={rowClass(selected.has(key), dropTarget === key)}
                  >
                    <td className="py-1.5 pl-2">
                      <span className="flex items-center gap-2">
                        <Folder size={15} className="text-accent" aria-hidden /> {f.name}
                      </span>
                    </td>
                    <td className="text-muted">Folder</td>
                    <td className="text-faint">{f.itemCount} items</td>
                    <td />
                    <td />
                    <td className="text-right text-muted">{timeAgo(f.updatedAt)}</td>
                    <td>
                      <MoreButton onOpen={(x, y) => setMenu({ x, y, key })} />
                    </td>
                  </tr>
                );
              })}
              {assets.map((a) => {
                const key: Key = `a:${a.id}`;
                const proc = a.processingStatus ? PROCESSING_STATUS[a.processingStatus] : null;
                return (
                  <tr
                    key={key}
                    draggable
                    aria-selected={selected.has(key)}
                    onDragStart={(e) => onItemDragStart(key, e)}
                    onClick={(e) => select(key, e)}
                    onDoubleClick={() => open(key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, key });
                    }}
                    className={rowClass(selected.has(key), false)}
                  >
                    <td className="py-1.5 pl-2">
                      <Link href={`/o/${orgSlug}/assets/${a.id}`} className="flex items-center gap-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                        <Thumb url={a.previewUrl} kind={a.kind} alt="" className="h-6 w-10 rounded-sm" />
                        <span className="truncate">{a.name}</span>
                        {a.versionCount > 1 && <span className="text-[11px] text-faint">v{a.versionNumber}</span>}
                      </Link>
                    </td>
                    <td className="text-muted">{a.extension?.toUpperCase() || KIND_LABELS[a.kind as keyof typeof KIND_LABELS]}</td>
                    <td>{proc && <Badge tone={a.processingStatus === "ready" ? "neutral" : proc.tone}>{a.processingStatus === "ready" ? REVIEW_STATUS[a.reviewStatus]?.label : proc.label}</Badge>}</td>
                    <td className="text-right text-muted tabular">{a.sizeBytes != null ? formatBytes(a.sizeBytes) : "—"}</td>
                    <td className="text-muted">{a.uploaderName ?? "—"}</td>
                    <td className="text-right text-muted">{timeAgo(a.createdAt)}</td>
                    <td>
                      <MoreButton onOpen={(x, y) => setMenu({ x, y, key })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {fileDrag && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft">
          <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] font-medium" style={{ boxShadow: "var(--shadow)" }}>
            Drop to upload to <span className="text-accent">{folder?.name ?? project.name}</span>
          </p>
        </div>
      )}

      {menu && <MenuList point={{ x: menu.x, y: menu.y }} items={itemMenu(menu.key)} onClose={() => setMenu(null)} />}

      <NewFolderDialog
        open={dialog?.type === "new-folder"}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const res = await createFolderAction(orgSlug, { projectId: project.id, parentId: folder?.id ?? null, name });
          return res.ok ? null : res.error.message;
        }}
      />
      {dialog?.type === "rename" && (
        <RenameDialog
          initial={dialog.name}
          isFolder={dialog.key.startsWith("f:")}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const id = dialog.key.slice(2);
            const res = dialog.key.startsWith("f:")
              ? await renameFolderAction(orgSlug, { projectId: project.id, folderId: id, name })
              : await renameAssetAction(orgSlug, { projectId: project.id, assetId: id, name });
            return res.ok ? null : res.error.message;
          }}
        />
      )}
      {dialog?.type === "move" && (
        <MoveDialog
          orgSlug={orgSlug}
          projectId={project.id}
          projectName={project.name}
          excluded={split(dialog.keys).folderIds}
          currentFolderId={folder?.id ?? null}
          count={dialog.keys.length}
          onClose={() => setDialog(null)}
          onMove={(target) => {
            move(dialog.keys, target);
            setDialog(null);
          }}
        />
      )}
      <Dialog
        open={dialog?.type === "delete"}
        onClose={() => setDialog(null)}
        title={dialog?.type === "delete" && dialog.keys.length > 1 ? `Delete ${dialog.keys.length} items?` : "Delete this item?"}
        description="Folders are deleted with everything inside them. Deleted items are kept in storage until the retention period ends and can be restored by an administrator."
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => {
                if (dialog?.type !== "delete") return;
                const { folderIds, assetIds } = split(dialog.keys);
                start(async () => {
                  const res = await deleteItemsAction(orgSlug, { projectId: project.id, folderIds, assetIds });
                  if (res.ok) {
                    setSelected(new Set());
                    setDialog(null);
                    toast("Deleted", "success");
                  } else toast(res.error.message, "error");
                });
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

const tileClass = (selected: boolean, drop: boolean) =>
  cn(
    "group cursor-default overflow-hidden rounded-lg border bg-surface-1 outline-none transition-colors select-none focus-visible:border-accent",
    selected ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
    drop && "border-accent ring-2 ring-accent/40",
  );

const rowClass = (selected: boolean, drop: boolean) =>
  cn("cursor-default border-b border-border select-none", selected ? "bg-accent-soft" : "hover:bg-surface-1", drop && "outline outline-2 outline-accent");

function MoreButton({ onOpen }: { onOpen: (x: number, y: number) => void }) {
  return (
    <IconButton
      label="More actions"
      className="size-6 opacity-60 group-hover:opacity-100 hover:opacity-100"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(r.left, r.bottom + 4);
      }}
    >
      <Ellipsis size={14} />
    </IconButton>
  );
}

function Crumb({
  href,
  label,
  active,
  drop,
  highlight,
}: {
  href: string;
  label: string;
  active: boolean;
  drop: Record<string, unknown>;
  highlight: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      {...drop}
      className={cn(
        "truncate rounded px-1.5 py-0.5",
        active ? "font-medium text-text" : "text-muted hover:bg-surface-3 hover:text-text",
        highlight && "bg-accent-soft text-accent",
      )}
    >
      {label}
    </Link>
  );
}

function useSubmit(onSubmit: (v: string) => Promise<string | null>, onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return {
    error,
    pending,
    submit: (value: string) =>
      start(async () => {
        const err = await onSubmit(value.trim());
        if (err) setError(err);
        else {
          setError(null);
          onDone();
        }
      }),
  };
}

function NewFolderDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (name: string) => Promise<string | null> }) {
  const { error, pending, submit } = useSubmit(onSubmit, onClose);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New folder"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-folder" loading={pending}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="new-folder"
        onSubmit={(e) => {
          e.preventDefault();
          submit(String(new FormData(e.currentTarget).get("name") ?? ""));
        }}
      >
        <Field label="Name" htmlFor="folder-name" error={error ?? undefined}>
          <Input id="folder-name" name="name" required maxLength={255} autoFocus placeholder="Selects" aria-invalid={!!error} />
        </Field>
      </form>
    </Dialog>
  );
}

function RenameDialog({ initial, isFolder, onClose, onSubmit }: { initial: string; isFolder: boolean; onClose: () => void; onSubmit: (name: string) => Promise<string | null> }) {
  const { error, pending, submit } = useSubmit(onSubmit, onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={isFolder ? "Rename folder" : "Rename asset"}
      description={isFolder ? undefined : "Renaming changes the display name only. The original file name is preserved."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename" loading={pending}>
            Rename
          </Button>
        </>
      }
    >
      <form
        id="rename"
        onSubmit={(e) => {
          e.preventDefault();
          submit(String(new FormData(e.currentTarget).get("name") ?? ""));
        }}
      >
        <Field label="Name" htmlFor="rename-input" error={error ?? undefined}>
          <Input
            id="rename-input"
            name="name"
            defaultValue={initial}
            required
            maxLength={255}
            autoFocus
            onFocus={(e) => {
              const dot = e.currentTarget.value.lastIndexOf(".");
              e.currentTarget.setSelectionRange(0, !isFolder && dot > 0 ? dot : e.currentTarget.value.length);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  orgSlug,
  projectId,
  projectName,
  excluded,
  currentFolderId,
  count,
  onClose,
  onMove,
}: {
  orgSlug: string;
  projectId: string;
  projectName: string;
  excluded: string[];
  currentFolderId: string | null;
  count: number;
  onClose: () => void;
  onMove: (target: string | null) => void;
}) {
  const [tree, setTree] = useState<{ id: string; name: string; parentId: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(currentFolderId);
  useEffect(() => {
    folderTreeAction(orgSlug, projectId).then((r) => (r.ok ? setTree(r.data) : setError(r.error.message)));
  }, [orgSlug, projectId]);

  // Folders that can't be targets: the moved folders and all their descendants.
  const blocked = useMemo(() => {
    const out = new Set(excluded);
    let grew = true;
    while (grew && tree) {
      grew = false;
      for (const f of tree) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
    return out;
  }, [excluded, tree]);

  const renderLevel = (parentId: string | null, depth: number): React.ReactNode =>
    tree
      ?.filter((f) => f.parentId === parentId && !blocked.has(f.id))
      .map((f) => (
        <div key={f.id}>
          <TreeRow label={f.name} depth={depth} selected={target === f.id} onSelect={() => setTarget(f.id)} />
          {renderLevel(f.id, depth + 1)}
        </div>
      ));

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move ${count} item${count === 1 ? "" : "s"}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={target === currentFolderId} onClick={() => onMove(target)}>
            Move here
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <div className="max-h-72 overflow-y-auto rounded-md border border-border p-1" role="tree" aria-label="Destination folder">
        <TreeRow label={projectName} depth={0} selected={target === null} onSelect={() => setTarget(null)} root />
        {tree ? renderLevel(null, 1) : <p className="p-2 text-[12px] text-faint">Loading folders…</p>}
      </div>
    </Dialog>
  );
}

function TreeRow({ label, depth, selected, onSelect, root }: { label: string; depth: number; selected: boolean; onSelect: () => void; root?: boolean }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      onClick={onSelect}
      className={cn("flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px]", selected ? "bg-accent-soft text-accent" : "hover:bg-surface-3")}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      <Folder size={14} className={root ? "text-muted" : "text-accent"} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}
