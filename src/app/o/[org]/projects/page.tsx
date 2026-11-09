import { FolderKanban, LayoutGrid, List } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { FilterLinks, withParams } from "@/components/app/filter-bar";
import { NewProjectButton, FavoriteButton } from "@/components/app/project-actions";
import { ProjectGrid } from "@/components/app/project-card";
import { Badge, EmptyState, PageHeader, Skeleton } from "@/components/ui/misc";
import { PROJECT_STATUS, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { can } from "@/server/authz/context";
import { listProjects } from "@/server/modules/projects";
import { listWorkspaces } from "@/server/modules/workspaces";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Projects" };

export default function ProjectsPage(props: PageProps<"/o/[org]/projects">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Projects {...props} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Projects({ params, searchParams }: PageProps<"/o/[org]/projects">) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requireOrg(org);
  const state = {
    status: one(sp.status),
    workspace: one(sp.workspace),
    sort: one(sp.sort) ?? "updated",
    view: one(sp.view) ?? "grid",
    scope: one(sp.scope) ?? "all",
  };
  const internal = can(ctx, "org.view_internal");
  const statusValue = (["active", "on_hold", "completed", "archived"] as const).find((s) => s === state.status);
  const [projects, workspaces] = await Promise.all([
    listProjects(ctx, {
      status: statusValue,
      workspaceId: state.workspace,
      sort: (["updated", "name", "created"] as const).find((s) => s === state.sort) ?? "updated",
      scope: (["all", "mine", "favorites"] as const).find((s) => s === state.scope) ?? "all",
    }),
    internal ? listWorkspaces(ctx) : Promise.resolve([]),
  ]);
  const base = `/o/${org}/projects`;
  const href = (patch: Record<string, string | undefined>) => withParams(base, state, patch);

  return (
    <>
      <PageHeader
        title="Projects"
        description={internal ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "Projects you've been given access to"}
        actions={can(ctx, "project.create") ? <NewProjectButton orgSlug={org} workspaces={workspaces} defaultWorkspaceId={state.workspace} /> : undefined}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
        <FilterLinks
          label="Scope"
          current={state.scope}
          hrefFor={(v) => href({ scope: v === "all" ? undefined : v })}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: "Assigned to me" },
            { value: "favorites", label: "Favorites" },
          ]}
        />
        <FilterLinks
          label="Status"
          current={state.status ?? "open"}
          hrefFor={(v) => href({ status: v === "open" ? undefined : v })}
          options={[{ value: "open", label: "Open" }, ...Object.entries(PROJECT_STATUS).map(([value, s]) => ({ value, label: s.label }))]}
        />
        {workspaces.length > 1 && (
          <FilterLinks
            label="Workspace"
            current={state.workspace ?? "any"}
            hrefFor={(v) => href({ workspace: v === "any" ? undefined : v })}
            options={[{ value: "any", label: "Any workspace" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <FilterLinks
            label="Sort"
            current={state.sort}
            hrefFor={(v) => href({ sort: v === "updated" ? undefined : v })}
            options={[
              { value: "updated", label: "Recent" },
              { value: "name", label: "Name" },
              { value: "created", label: "Created" },
            ]}
          />
          <div role="group" aria-label="View" className="flex rounded-md border border-border bg-surface-1 p-0.5">
            <Link aria-label="Grid view" aria-current={state.view === "grid" ? "true" : undefined} href={href({ view: undefined })} className={cn("rounded p-1", state.view === "grid" ? "bg-surface-3 text-text" : "text-muted")}>
              <LayoutGrid size={14} />
            </Link>
            <Link aria-label="List view" aria-current={state.view === "list" ? "true" : undefined} href={href({ view: "list" })} className={cn("rounded p-1", state.view === "list" ? "bg-surface-3 text-text" : "text-muted")}>
              <List size={14} />
            </Link>
          </div>
        </div>
      </div>
      <div className="p-6">
        {!projects.length ? (
          <EmptyState icon={<FolderKanban size={28} />} title="No projects match">
            {can(ctx, "project.create") ? "Try another filter, or create a new project." : "Projects shared with you will appear here."}
          </EmptyState>
        ) : state.view === "list" ? (
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-faint uppercase">
              <tr className="border-b border-border">
                <th className="w-8 py-2 font-medium" />
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Client</th>
                <th className="py-2 font-medium">Workspace</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Assets</th>
                <th className="py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-b border-border hover:bg-surface-1">
                  <td className="py-1.5">
                    <FavoriteButton orgSlug={org} projectId={p.id} favorite={p.isFavorite} />
                  </td>
                  <td className="py-1.5">
                    <Link href={`${base}/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="py-1.5 text-muted">{p.clientName ?? "—"}</td>
                  <td className="py-1.5 text-muted">{p.workspaceName}</td>
                  <td className="py-1.5">
                    <Badge tone={PROJECT_STATUS[p.status]?.tone}>{PROJECT_STATUS[p.status]?.label}</Badge>
                  </td>
                  <td className="py-1.5 text-right text-muted tabular">{p.assetCount}</td>
                  <td className="py-1.5 text-right text-muted">{timeAgo(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ProjectGrid projects={projects} orgSlug={org} />
        )}
      </div>
    </>
  );
}
