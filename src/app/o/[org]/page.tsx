import { CircleAlert, Inbox, Upload } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActivityList } from "@/components/app/activity-list";
import { Thumb } from "@/components/app/kind-icon";
import { NewProjectButton } from "@/components/app/project-actions";
import { ProjectGrid } from "@/components/app/project-card";
import { Card, EmptyState, PageHeader, Progress, Section, Skeleton } from "@/components/ui/misc";
import { formatBytes } from "@/lib/file-types";
import { PROCESSING_STATUS, timeAgo } from "@/lib/format";
import { can } from "@/server/authz/context";
import { getDashboard } from "@/server/modules/dashboard";
import { listWorkspaces } from "@/server/modules/workspaces";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Home" };

export default function DashboardPage({ params }: PageProps<"/o/[org]">) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard params={params} />
    </Suspense>
  );
}

async function Dashboard({ params }: Pick<PageProps<"/o/[org]">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  // Clients and guests have no internal dashboard; they land on what was shared with them.
  if (!can(ctx, "org.view_internal")) redirect(`/o/${org}/shared`);
  const [d, workspaces] = await Promise.all([getDashboard(ctx), listWorkspaces(ctx)]);
  const firstName = ctx.userName.split(" ")[0];

  return (
    <>
      <PageHeader
        eyebrow={ctx.orgName}
        title={`Welcome back, ${firstName}`}
        actions={can(ctx, "project.create") ? <NewProjectButton orgSlug={org} workspaces={workspaces} /> : undefined}
      />
      <div className="grid gap-8 p-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-8">
          {d.failed.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-[13px]">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="font-medium text-danger">{d.failed.length} file{d.failed.length === 1 ? "" : "s"} failed processing</p>
                <ul className="mt-1 text-muted">
                  {d.failed.slice(0, 3).map((f) => (
                    <li key={f.id} className="truncate">
                      <Link className="text-text hover:underline" href={`/o/${org}/assets/${f.id}`}>
                        {f.name}
                      </Link>{" "}
                      — {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {d.favorites.length > 0 && (
            <Section title="Favorites">
              <ProjectGrid projects={d.favorites} orgSlug={org} />
            </Section>
          )}

          <Section
            title="Recent projects"
            action={
              <Link href={`/o/${org}/projects`} className="text-[12px] text-muted hover:text-text">
                All projects
              </Link>
            }
          >
            {d.recent.length ? (
              <ProjectGrid projects={d.recent.slice(0, 8)} orgSlug={org} />
            ) : (
              <EmptyState
                icon={<Inbox size={28} />}
                title="No projects yet"
                action={can(ctx, "project.create") ? <NewProjectButton orgSlug={org} workspaces={workspaces} /> : undefined}
              >
                {can(ctx, "project.create")
                  ? "Create a project to start uploading media and inviting collaborators."
                  : "You'll see projects here once someone adds you to one."}
              </EmptyState>
            )}
          </Section>

          {d.mine.length > 0 && (
            <Section title="Assigned to me">
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-1">
                {d.mine.map((p) => (
                  <li key={p.id}>
                    <Link href={`/o/${org}/projects/${p.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-[12px] text-faint">{p.clientName ?? p.workspaceName}</span>
                      <span className="w-20 text-right text-[12px] text-faint">{timeAgo(p.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Recently uploaded">
            {d.uploads.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                {d.uploads.map((u) => (
                  <Link key={u.id} href={`/o/${org}/assets/${u.id}`} className="group overflow-hidden rounded-lg border border-border bg-surface-1 hover:border-border-strong">
                    <Thumb url={u.previewUrl} kind={u.kind} alt="" className="aspect-video" />
                    <div className="p-2">
                      <p className="truncate text-[12px] font-medium">{u.name}</p>
                      <p className="truncate text-[11px] text-faint">
                        {u.projectName} · {u.processingStatus === "ready" ? timeAgo(u.uploadedAt) : PROCESSING_STATUS[u.processingStatus]?.label}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState icon={<Upload size={26} />} title="Nothing uploaded yet">
                Open a project and drop files anywhere to upload.
              </EmptyState>
            )}
          </Section>
        </div>

        <aside className="flex flex-col gap-8">
          {d.storage && (
            <Section title="Storage">
              <Card className="p-4">
                <p className="text-[20px] font-semibold tabular">{formatBytes(d.storage.originalBytes)}</p>
                <p className="text-[12px] text-faint">
                  {d.storage.fileCount} files · {formatBytes(d.storage.derivedBytes)} previews
                  {d.storage.trashBytes > 0 ? ` · ${formatBytes(d.storage.trashBytes)} in trash` : ""}
                </p>
                {d.storage.quotaBytes ? (
                  <div className="mt-3">
                    <Progress value={(d.storage.originalBytes / d.storage.quotaBytes) * 100} />
                    <p className="mt-1 text-[11px] text-faint">of {formatBytes(d.storage.quotaBytes)} quota</p>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-faint">No quota configured</p>
                )}
                {can(ctx, "org.manage_storage") && (
                  <Link href={`/o/${org}/storage`} className="mt-3 inline-block text-[12px] text-muted hover:text-text">
                    Storage details →
                  </Link>
                )}
              </Card>
            </Section>
          )}
          <Section title="Activity">
            <ActivityList items={d.activity} orgSlug={org} compact />
          </Section>
        </aside>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="mb-8 h-8 w-64" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="aspect-[4/3]" />
        ))}
      </div>
    </div>
  );
}
