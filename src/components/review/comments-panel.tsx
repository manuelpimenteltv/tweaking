"use client";

import { CheckCircle2, CircleDot, Ellipsis, MessageSquare, PenLine, RotateCcw, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { createThreadAction, deleteCommentAction, mentionableAction, replyAction, setThreadStatusAction } from "@/server/actions/review";
import type { AnnotationShape } from "@/server/db/schema";
import type { ReviewComment, ReviewThread } from "@/server/modules/review";
import type { Anchor, ThreadFilter } from "@/lib/review";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/components/ui/button";
import { MenuList } from "@/components/ui/menu";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

export type ComposerApi = { focus: () => void };
type Person = { id: string; name: string; email: string };

type Props = {
  orgSlug: string;
  versionId: string;
  versionNumber: number;
  data: { threads: ReviewThread[]; counts: { open: number; resolved: number }; otherVersions: { versionNumber: number; open: number; total: number }[] };
  filter: ThreadFilter;
  onFilter: (f: ThreadFilter) => void;
  selected: string | null;
  onSelect: (t: ReviewThread) => void;
  canComment: boolean;
  currentUserId: string;
  /** Where a new comment attaches by default (current frame / page / cell); null = only general comments. */
  position: { label: string; anchor: Anchor } | null;
  /** Short label for a thread's anchor (timecode, "p. 3", "Summary!B7"…); null = general. */
  describe: (t: ReviewThread) => string | null;
  /** Monospace labels (timecodes, cell refs) vs. prose labels (pages). */
  monoLabels?: boolean;
  draft: { count: number; label: string | null; offPosition: boolean };
  /** Whether this medium supports drawings (spreadsheets don't). */
  drawingSupported: boolean;
  emptyHint: string;
  drawing: boolean;
  onStartDrawing: () => void;
  onClearDraft: () => void;
  takeDraft: () => { shapes: AnnotationShape[]; anchor: Anchor | null };
  onPosted: (threadId: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onGoToDraft: () => void;
  /** Called when typing starts at the current position (video pauses). */
  pause?: () => void;
};

export const CommentsPanel = forwardRef<ComposerApi, Props>(function CommentsPanel(p, ref) {
  const toast = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [search, setSearch] = useState(p.filter.q ?? "");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mentionableAction(p.orgSlug, p.versionId).then((r) => r.ok && setPeople(r.data));
  }, [p.orgSlug, p.versionId]);

  // Debounced text search.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((p.filter.q ?? "") !== search) p.onFilter({ ...p.filter, q: search || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps -- only react to typing

  // Keep the selected thread in view (e.g. after clicking a timeline marker).
  useEffect(() => {
    if (!p.selected) return;
    list.current?.querySelector(`[data-thread="${p.selected}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.selected]);

  const authors = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of p.data.threads) for (const c of t.comments) if (c.authorId) m.set(c.authorId, c.authorName);
    return [...m.entries()];
  }, [p.data.threads]);

  const filtered = !!(p.filter.authorId || p.filter.q || p.filter.annotated || (p.filter.status && p.filter.status !== "all"));

  return (
    <>
      {/* Filters */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Status" className="flex rounded-md border border-border p-0.5 text-[12px]">
            {(["all", "open", "resolved"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={(p.filter.status ?? "all") === s}
                onClick={() => p.onFilter({ ...p.filter, status: s })}
                className={cn("rounded px-2 py-0.5 capitalize", (p.filter.status ?? "all") === s ? "bg-surface-3 text-text" : "text-muted hover:text-text")}
              >
                {s === "all" ? "All" : s === "open" ? `Open ${p.data.counts.open}` : `Resolved ${p.data.counts.resolved}`}
              </button>
            ))}
          </div>
          <select
            aria-label="Sort comments"
            value={p.filter.sort === "timecode" ? "position" : (p.filter.sort ?? "position")}
            onChange={(e) => p.onFilter({ ...p.filter, sort: e.target.value as ThreadFilter["sort"] })}
            className="ml-auto h-7 rounded-md border border-border bg-surface-2 px-1.5 text-[12px]"
          >
            <option value="position">By position</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 focus-within:border-accent">
            <Search size={13} className="text-faint" aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search comments" aria-label="Search comments" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" />
          </label>
          <select
            aria-label="Filter by author"
            value={p.filter.authorId ?? ""}
            onChange={(e) => p.onFilter({ ...p.filter, authorId: e.target.value || undefined })}
            className="h-7 max-w-32 rounded-md border border-border bg-surface-2 px-1.5 text-[12px]"
          >
            <option value="">Anyone</option>
            {authors.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={!!p.filter.annotated}
            title="Only comments with drawings"
            onClick={() => p.onFilter({ ...p.filter, annotated: p.filter.annotated ? undefined : true })}
            className={cn("grid size-7 place-items-center rounded-md border border-border", p.filter.annotated ? "bg-accent-soft text-accent" : "text-muted hover:text-text")}
          >
            <PenLine size={13} />
          </button>
        </div>
      </div>

      {p.data.otherVersions.length > 0 && (
        <div className="border-b border-border bg-surface-2 px-3 py-2 text-[12px] text-muted">
          Feedback on other versions stays with them:{" "}
          {p.data.otherVersions.map((o, i) => (
            <span key={o.versionNumber}>
              {i > 0 && ", "}
              <Link href={`?v=${o.versionNumber}`} className="text-text hover:underline">
                v{o.versionNumber}
              </Link>{" "}
              ({o.open} open / {o.total})
            </span>
          ))}
        </div>
      )}

      {/* Threads */}
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto" data-testid="thread-list">
        {p.data.threads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-[13px] text-muted">
            <MessageSquare size={22} className="text-faint" />
            {filtered ? "No comments match these filters." : `No comments on v${p.versionNumber} yet.`}
            {!filtered && p.canComment && <span className="text-[12px] text-faint">{p.emptyHint}</span>}
          </div>
        ) : (
          <ol>
            {p.data.threads.map((t) => (
              <ThreadCard key={t.id} thread={t} {...p} people={people} toast={toast} />
            ))}
          </ol>
        )}
      </div>

      {p.canComment && <Composer ref={ref} {...p} people={people} toast={toast} />}
    </>
  );
});

function renderBody(c: ReviewComment): ReactNode {
  if (!c.mentions.length) return c.body;
  const names = c.mentions.map((m) => m.name).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`);
  return c.body.split(re).map((part, i) =>
    names.some((n) => part === `@${n}`) ? (
      <span key={i} className="rounded bg-accent-soft px-0.5 font-medium text-accent">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function ThreadCard({
  thread: t,
  describe,
  monoLabels,
  selected,
  onSelect,
  canComment,
  currentUserId,
  orgSlug,
  onChanged,
  people,
  toast,
}: Props & { thread: ReviewThread; people: Person[]; toast: ReturnType<typeof useToast> }) {
  const [replying, setReplying] = useState(false);
  const [pending, start] = useTransition();
  const [root, ...replies] = t.comments;
  const hasDrawing = t.comments.some((c) => c.annotation);
  const isSelected = selected === t.id;
  const label = describe(t);

  const setStatus = (status: "open" | "resolved") =>
    start(async () => {
      const res = await setThreadStatusAction(orgSlug, { threadId: t.id, status });
      if (!res.ok) toast(res.error.message, "error");
      await onChanged();
    });

  return (
    <li
      data-thread={t.id}
      data-testid="thread"
      className={cn(
        "border-b border-border px-3 py-3 transition-colors",
        isSelected ? "bg-accent-soft/60" : "hover:bg-surface-2",
        t.status === "resolved" && !isSelected && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2" onClick={() => onSelect(t)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(t)} aria-label={`Go to comment${label ? ` at ${label}` : ""}`}>
        {label ? (
          <span className={cn("rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-accent tabular", monoLabels && "font-mono")} data-testid="thread-anchor">
            {label}
          </span>
        ) : (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">General</span>
        )}
        {hasDrawing && <PenLine size={12} className="text-muted" aria-label="Has drawing" />}
        {t.status === "resolved" ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-success">
            <CheckCircle2 size={12} /> Resolved{t.resolvedByName ? ` by ${t.resolvedByName}` : ""}
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-accent">
            <CircleDot size={12} /> Open
          </span>
        )}
      </div>
      {root && <CommentView c={root} orgSlug={orgSlug} currentUserId={currentUserId} onChanged={onChanged} toast={toast} />}
      {replies.length > 0 && (
        <ol className="mt-2 ml-3 flex flex-col gap-2 border-l border-border pl-3">
          {replies.map((c) => (
            <li key={c.id}>
              <CommentView c={c} orgSlug={orgSlug} currentUserId={currentUserId} onChanged={onChanged} toast={toast} compact />
            </li>
          ))}
        </ol>
      )}
      <div className="mt-2 flex items-center gap-1">
        {canComment && !replying && (
          <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
        {t.canResolve &&
          (t.status === "open" ? (
            <Button size="sm" variant="ghost" loading={pending} onClick={() => setStatus("resolved")}>
              <CheckCircle2 size={13} /> Resolve
            </Button>
          ) : (
            <Button size="sm" variant="ghost" loading={pending} onClick={() => setStatus("open")}>
              <RotateCcw size={13} /> Reopen
            </Button>
          ))}
      </div>
      {replying && (
        <ReplyBox
          people={people}
          onCancel={() => setReplying(false)}
          onSubmit={async (body, mentions) => {
            const res = await replyAction(orgSlug, { threadId: t.id, body, mentions });
            if (!res.ok) {
              toast(res.error.message, "error");
              return false;
            }
            setReplying(false);
            await onChanged();
            return true;
          }}
        />
      )}
    </li>
  );
}

function CommentView({
  c,
  orgSlug,
  currentUserId,
  onChanged,
  toast,
  compact,
}: {
  c: ReviewComment;
  orgSlug: string;
  currentUserId: string;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
  compact?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className={cn("group mt-2 flex gap-2", compact && "mt-0")}>
      <Avatar name={c.authorName} size={compact ? 18 : 22} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px]">
          <span className="font-medium text-text">{c.authorName}</span> <span className="text-faint">{timeAgo(c.createdAt)}</span>
        </p>
        <p className={cn("text-[13px] break-words whitespace-pre-wrap", c.deleted ? "text-faint italic" : "text-text")} data-testid="comment-body">
          {c.deleted ? "Comment deleted" : renderBody(c)}
        </p>
      </div>
      {!c.deleted && c.authorId === currentUserId && (
        <>
          <IconButton ref={btn} label="Comment actions" className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setMenu((m) => !m)}>
            <Ellipsis size={13} />
          </IconButton>
          {menu && (
            <MenuList
              anchor={btn}
              onClose={() => setMenu(false)}
              items={[
                {
                  label: "Delete comment",
                  icon: <Trash2 size={13} />,
                  danger: true,
                  onSelect: async () => {
                    const res = await deleteCommentAction(orgSlug, c.id);
                    if (!res.ok) toast(res.error.message, "error");
                    await onChanged();
                  },
                },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Mention-aware text input ────────────────────────────────────────────────

function useMentions(people: Person[]) {
  const [picked, setPicked] = useState<Person[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const suggestions = useMemo(
    () =>
      query == null
        ? []
        : people.filter((u) => u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6),
    [people, query],
  );
  return { picked, setPicked, query, setQuery, active, setActive, suggestions };
}

function MentionTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  inputRef,
  label,
  mentions,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  label: string;
  mentions: ReturnType<typeof useMentions>;
}) {
  const local = useRef<HTMLTextAreaElement>(null);
  const ta = inputRef ?? local;
  const { query, setQuery, suggestions, active, setActive, setPicked } = mentions;

  const detect = (text: string, caret: number) => {
    const m = /(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(text.slice(0, caret));
    setQuery(m ? m[1] : null);
    setActive(0);
  };
  const pick = (u: Person) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([\p{L}\p{N}._-]{0,30})$/u, `@${u.name} `);
    const next = before + value.slice(caret);
    onChange(next);
    setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u]));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ta}
        value={value}
        autoFocus={autoFocus}
        rows={2}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (query != null && suggestions.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((active + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(suggestions[active]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setQuery(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="max-h-40 min-h-16 w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2.5 py-2 text-[13px] outline-none placeholder:text-faint focus:border-accent"
      />
      {query != null && suggestions.length > 0 && (
        <ul role="listbox" aria-label="Mention suggestions" className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-md bg-surface-3 p-1" style={{ boxShadow: "var(--shadow)" }}>
          {suggestions.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]", i === active ? "bg-surface-4" : "hover:bg-surface-4")}
              >
                <Avatar name={u.name} size={18} />
                <span className="truncate">{u.name}</span>
                <span className="ml-auto truncate text-faint">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const mentionIds = (body: string, picked: Person[]) => picked.filter((u) => body.includes(`@${u.name}`)).map((u) => u.id);

function ReplyBox({ people, onSubmit, onCancel }: { people: Person[]; onSubmit: (body: string, mentions: string[]) => Promise<boolean>; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const mentions = useMentions(people);
  const [pending, start] = useTransition();
  const submit = () => {
    if (!body.trim()) return;
    start(async () => {
      if (await onSubmit(body.trim(), mentionIds(body, mentions.picked))) setBody("");
    });
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <MentionTextarea value={body} onChange={setBody} onSubmit={submit} placeholder="Reply… (@ to mention)" autoFocus label="Reply" mentions={mentions} />
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={pending} disabled={!body.trim()} onClick={submit}>
          Reply
        </Button>
      </div>
    </div>
  );
}

const Composer = forwardRef<ComposerApi, Props & { people: Person[]; toast: ReturnType<typeof useToast> }>(function Composer(p, ref) {
  const [body, setBody] = useState("");
  const [atPosition, setAtPosition] = useState(true);
  const mentions = useMentions(p.people);
  const [pending, start] = useTransition();
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);

  const hasDraft = p.draft.count > 0;
  const anchored = hasDraft || (atPosition && !!p.position);

  const submit = () => {
    if (!body.trim()) return;
    const drawn = p.takeDraft();
    start(async () => {
      const res = await createThreadAction(p.orgSlug, {
        versionId: p.versionId,
        anchor: drawn.shapes.length ? drawn.anchor : atPosition && p.position ? p.position.anchor : null,
        body: body.trim(),
        mentions: mentionIds(body, mentions.picked),
        shapes: drawn.shapes,
      });
      if (!res.ok) {
        p.toast(res.error.message, "error");
        return;
      }
      setBody("");
      mentions.setPicked([]);
      // Hand the keyboard back to the viewer so review shortcuts work right away.
      ta.current?.blur();
      await p.onPosted(res.data.threadId);
    });
  };

  return (
    <div className="border-t border-border p-3" data-testid="composer">
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        {hasDraft ? (
          <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-accent">
            <PenLine size={12} /> {p.draft.count} drawing{p.draft.count === 1 ? "" : "s"}
            {p.draft.label && (
              <>
                {" "}on <span className={cn(p.monoLabels && "font-mono")}>{p.draft.label}</span>
              </>
            )}
            {p.draft.offPosition && (
              <button type="button" className="ml-1 underline" onClick={p.onGoToDraft}>
                go there
              </button>
            )}
            <button type="button" aria-label="Discard drawing" className="ml-0.5" onClick={p.onClearDraft}>
              <X size={12} />
            </button>
          </span>
        ) : p.position ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted">
            <input type="checkbox" checked={atPosition} onChange={(e) => setAtPosition(e.target.checked)} className="accent-[var(--accent)]" />
            At{" "}
            <span className={cn("text-text", p.monoLabels && "font-mono")} data-testid="composer-position">
              {p.position.label}
            </span>
          </label>
        ) : (
          <span className="text-muted">General comment</span>
        )}
        {p.drawingSupported && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={p.onStartDrawing} aria-pressed={p.drawing}>
            <PenLine size={13} /> {hasDraft ? "Draw more" : "Draw"}
          </Button>
        )}
      </div>
      <MentionTextarea
        inputRef={ta}
        value={body}
        onChange={(v) => {
          setBody(v);
          if (v && atPosition) p.pause?.();
        }}
        onSubmit={submit}
        placeholder={anchored ? "Leave a comment here… (@ to mention)" : "Leave a general comment… (@ to mention)"}
        label="New comment"
        mentions={mentions}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-faint">Enter to post · Shift+Enter for a new line</span>
        <Button size="sm" variant="primary" loading={pending} disabled={!body.trim()} onClick={submit}>
          Post
        </Button>
      </div>
    </div>
  );
});
