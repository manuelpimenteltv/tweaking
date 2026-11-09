import { Layers } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { WorkspaceControls, NewWorkspaceButton } from "@/components/app/workspace-controls";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/misc";
import { can } from "@/server/authz/context";
import { listWorkspaces } from "@/server/modules/workspaces";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Workspaces" };

export default function WorkspacesPage({ params }: PageProps<"/o/[org]/workspaces">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-48" />}>
      <Workspaces params={params} />
    </Suspense>
  );
}

async function Workspaces({ params }: Pick<PageProps<"/o/[org]/workspaces">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const workspaces = await listWorkspaces(ctx);
  const manage = can(ctx, "project.create");
  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Group projects by client, department or production slate."
        actions={manage ? <NewWorkspaceButton orgSlug={org} /> : undefined}
      />
      <div className="p-6">
        {workspaces.length ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {workspaces.map((w) => (
              <li key={w.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4">
                <div className="flex items-start gap-2">
                  <Layers size={16} className="mt-0.5 text-accent" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link href={`/o/${org}/projects?workspace=${w.id}`} className="font-medium hover:underline">
                      {w.name}
                    </Link>
                    {w.description && <p className="mt-0.5 text-[12px] text-muted">{w.description}</p>}
                  </div>
                  {manage && (
                    <WorkspaceControls orgSlug={org} workspace={{ id: w.id, name: w.name, description: w.description }} canDelete={can(ctx, "org.manage_settings")} />
                  )}
                </div>
                <p className="text-[12px] text-faint">
                  {w.projectCount} project{w.projectCount === 1 ? "" : "s"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Layers size={26} />} title="No workspaces" />
        )}
      </div>
    </>
  );
}
