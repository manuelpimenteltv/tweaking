import { Users } from "lucide-react";
import { Suspense } from "react";
import { ProjectGrid } from "@/components/app/project-card";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/misc";
import { listProjects } from "@/server/modules/projects";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Shared with me" };

export default function SharedPage({ params }: PageProps<"/o/[org]/shared">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-48" />}>
      <Shared params={params} />
    </Suspense>
  );
}

/** Projects the user was explicitly added to (the only view clients and guests have). */
async function Shared({ params }: Pick<PageProps<"/o/[org]/shared">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const projects = await listProjects(ctx, { scope: "mine", sort: "updated" });
  return (
    <>
      <PageHeader title="Shared with me" description={`Projects at ${ctx.orgName} that you've been added to.`} />
      <div className="p-6">
        {projects.length ? (
          <ProjectGrid projects={projects} orgSlug={org} />
        ) : (
          <EmptyState icon={<Users size={26} />} title="Nothing shared with you yet">
            When someone adds you to a project, it will appear here.
          </EmptyState>
        )}
      </div>
    </>
  );
}
