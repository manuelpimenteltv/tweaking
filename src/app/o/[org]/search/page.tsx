import { Folder, FolderKanban, Search as SearchIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Thumb } from "@/components/app/kind-icon";
import { FilterLinks, withParams } from "@/components/app/filter-bar";
import { Avatar, Badge, EmptyState, PageHeader, Section, Skeleton } from "@/components/ui/misc";
import { formatBytes, KIND_LABELS } from "@/lib/file-types";
import { PROCESSING_STATUS, PROJECT_STATUS, REVIEW_STATUS, timeAgo } from "@/lib/format";
import { search } from "@/server/modules/search";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Search" };

export default function SearchPage(props: PageProps<"/o/[org]/search">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-48" />}>
      <Results {...props} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Results({ params, searchParams }: PageProps<"/o/[org]/search">) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requireOrg(org);
  const state = {
    q: one(sp.q) ?? "",
    type: one(sp.type),
    kind: one(sp.kind),
    processing: one(sp.processing),
    status: one(sp.status),
    from: one(sp.from),
  };
  const kinds = Object.keys(KIND_LABELS);
  const r = await search(ctx, {
    q: state.q,
    type: (["all", "projects", "folders", "assets", "people"] as const).find((t) => t === state.type) ?? "all",
    kind: kinds.includes(state.kind ?? "") ? (state.kind as never) : undefined,
    processing: Object.keys(PROCESSING_STATUS).includes(state.processing ?? "") ? (state.processing as never) : undefined,
    reviewStatus: Object.keys(REVIEW_STATUS).includes(state.status ?? "") ? (state.status as never) : undefined,
    from: state.from && /^\d{4}-\d{2}-\d{2}$/.test(state.from) ? state.from : undefined,
  });
  const base = `/o/${org}/search`;
  const href = (patch: Record<string, string | undefined>) => withParams(base, state, patch);
  const total = r.projects.length + r.folders.length + r.assets.length + r.people.length;
  const hasQuery = !!(state.q || state.kind || state.processing || state.status || state.from);

  return (
    <>
      <PageHeader title={state.q ? `Results for “${state.q}”` : "Search"} description={hasQuery ? `${total} result${total === 1 ? "" : "s"} you have access to` : undefined} />
      <form action={base} className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5" role="search">
        <label className="flex h-8 min-w-64 flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-2.5 focus-within:border-accent">
          <SearchIcon size={14} className="text-faint" aria-hidden />
          <input name="q" defaultValue={state.q} placeholder="Names, file types (mov, pdf), clients, metadata…" aria-label="Search" className="flex-1 bg-transparent outline-none" />
        </label>
        {state.type && <input type="hidden" name="type" value={state.type} />}
        <select name="kind" defaultValue={state.kind ?? ""} aria-label="Asset type" className="h-8 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px]">
          <option value="">Any type</option>
          {Object.entries(KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={state.status ?? ""} aria-label="Review status" className="h-8 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px]">
          <option value="">Any review status</option>
          {Object.entries(REVIEW_STATUS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
        <select name="processing" defaultValue={state.processing ?? ""} aria-label="Processing" className="h-8 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px]">
          <option value="">Any processing state</option>
          {Object.entries(PROCESSING_STATUS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Since
          <input type="date" name="from" defaultValue={state.from} className="h-8 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px]" />
        </label>
        <button type="submit" className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg">
          Search
        </button>
      </form>
      <div className="flex flex-col gap-8 p-6">
        {hasQuery && (
          <FilterLinks
            label="Result type"
            current={state.type ?? "all"}
            hrefFor={(v) => href({ type: v === "all" ? undefined : v })}
            options={[
              { value: "all", label: "All" },
              { value: "projects", label: `Projects` },
              { value: "folders", label: `Folders` },
              { value: "assets", label: `Assets` },
              { value: "people", label: `People` },
            ]}
          />
        )}
        {!hasQuery ? (
          <EmptyState icon={<SearchIcon size={26} />} title="Search your studio">
            Find projects, folders, assets and people. Results only include what you have access to.
          </EmptyState>
        ) : total === 0 ? (
          <EmptyState icon={<SearchIcon size={26} />} title="No matches">
            Try a different term or remove filters.
          </EmptyState>
        ) : (
          <>
            {r.projects.length > 0 && (
              <Section title="Projects">
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
                  {r.projects.map((p) => (
                    <li key={p.id}>
                      <Link href={`/o/${org}/projects/${p.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                        <FolderKanban size={15} className="text-muted" />
                        <span className="flex-1 truncate">{p.name}</span>
                        {p.clientName && <span className="text-[12px] text-faint">{p.clientName}</span>}
                        <Badge tone={PROJECT_STATUS[p.status]?.tone}>{PROJECT_STATUS[p.status]?.label}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {r.folders.length > 0 && (
              <Section title="Folders">
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
                  {r.folders.map((f) => (
                    <li key={f.id}>
                      <Link href={`/o/${org}/projects/${f.projectId}?folder=${f.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                        <Folder size={15} className="text-accent" />
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="text-[12px] text-faint">{f.projectName}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {r.assets.length > 0 && (
              <Section title="Assets">
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
                  {r.assets.map((a) => (
                    <li key={a.id}>
                      <Link href={`/o/${org}/assets/${a.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                        <Thumb url={a.previewUrl} kind={a.kind} alt="" className="h-8 w-14 shrink-0 rounded-sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{a.name}</span>
                          <span className="block truncate text-[11px] text-faint">
                            {a.projectName} · {a.uploaderName ?? "—"} · {timeAgo(a.createdAt)}
                          </span>
                        </span>
                        {a.processingStatus && a.processingStatus !== "ready" && <Badge tone={PROCESSING_STATUS[a.processingStatus]?.tone}>{PROCESSING_STATUS[a.processingStatus]?.label}</Badge>}
                        <span className="w-20 text-right text-[12px] text-faint tabular">{a.sizeBytes != null ? formatBytes(a.sizeBytes) : ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {r.people.length > 0 && (
              <Section title="People">
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
                  {r.people.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                      <Avatar name={p.name} size={24} />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[12px] text-faint">{p.email}</span>
                      <Badge>{p.roleName}</Badge>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}
