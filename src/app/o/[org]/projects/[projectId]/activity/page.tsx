import { Suspense } from "react";
import { ActivityList } from "@/components/app/activity-list";
import { ProjectHeader } from "@/components/app/project-header";
import { Skeleton } from "@/components/ui/misc";
import { listProjectActivity } from "@/server/modules/activity";
import { getProject } from "@/server/modules/projects";
import { requireOrg } from "@/server/next/session";

export default function ProjectActivityPage(props: PageProps<"/o/[org]/projects/[projectId]/activity">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Activity {...props} />
    </Suspense>
  );
}

async function Activity({ params }: PageProps<"/o/[org]/projects/[projectId]/activity">) {
  const { org, projectId } = await params;
  const ctx = await requireOrg(org);
  const [project, items] = await Promise.all([getProject(ctx, projectId), listProjectActivity(ctx, projectId, 200)]);
  return (
    <div>
      <ProjectHeader orgSlug={org} project={project} tab="activity" canManage={project.permissions.includes("project.edit")} />
      <div className="max-w-2xl p-6">
        <ActivityList items={items} orgSlug={org} />
      </div>
    </div>
  );
}
