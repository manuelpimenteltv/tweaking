import { Suspense } from "react";
import { ProjectDetailsForm, ProjectDangerZone } from "@/components/app/project-settings";
import { ProjectMembers } from "@/components/app/project-members";
import { ProjectHeader } from "@/components/app/project-header";
import { Card, Section, Skeleton } from "@/components/ui/misc";
import { formatBytes } from "@/lib/file-types";
import { dateTime } from "@/lib/format";
import { can } from "@/server/authz/context";
import { listMembers } from "@/server/modules/members";
import { getProject, listProjectMembers } from "@/server/modules/projects";
import { listWorkspaces } from "@/server/modules/workspaces";
import { requireOrg } from "@/server/next/session";

export default function ProjectSettingsPage(props: PageProps<"/o/[org]/projects/[projectId]/settings">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-96" />}>
      <Settings {...props} />
    </Suspense>
  );
}

async function Settings({ params }: PageProps<"/o/[org]/projects/[projectId]/settings">) {
  const { org, projectId } = await params;
  const ctx = await requireOrg(org);
  const project = await getProject(ctx, projectId);
  const internal = can(ctx, "org.view_internal");
  const [members, workspaces, orgMembers] = await Promise.all([
    listProjectMembers(ctx, projectId),
    internal ? listWorkspaces(ctx) : Promise.resolve([]),
    internal ? listMembers(ctx) : Promise.resolve([]),
  ]);
  const editable = project.permissions.includes("project.edit");
  const manageMembers = project.permissions.includes("project.manage_members");

  return (
    <div className="flex min-h-full flex-col">
      <ProjectHeader orgSlug={org} project={project} tab="settings" canManage={editable} />
      <div className="grid max-w-5xl gap-8 p-6 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-8">
          <Section title="Details">
            <Card className="p-4">
              <ProjectDetailsForm
                orgSlug={org}
                editable={editable}
                workspaces={workspaces.length ? workspaces : [{ id: project.workspaceId, name: project.workspaceName }]}
                managers={orgMembers.filter((m) => ["owner", "admin", "project_manager"].includes(m.roleKey)).map((m) => ({ id: m.userId, name: m.name }))}
                project={{
                  id: project.id,
                  name: project.name,
                  description: project.description,
                  status: project.status,
                  workspaceId: project.workspaceId,
                  clientName: project.clientName ?? "",
                  clientEmail: project.clientEmail ?? "",
                  managerUserId: project.managerUserId ?? "",
                  managerName: project.managerName ?? "",
                  metadata: Object.entries(project.metadata ?? {}).map(([key, value]) => ({ key, value })),
                }}
              />
            </Card>
          </Section>
          <Section title={`People (${members.length})`}>
            <ProjectMembers
              orgSlug={org}
              projectId={project.id}
              members={members.map((m) => ({ ...m, addedAt: m.addedAt.toISOString() }))}
              canManage={manageMembers}
              canInviteManagers={can(ctx, "org.manage_members")}
              currentUserId={ctx.userId}
            />
          </Section>
          {project.permissions.includes("project.delete") && <ProjectDangerZone orgSlug={org} projectId={project.id} name={project.name} />}
        </div>
        <aside className="flex flex-col gap-4">
          <Section title="Summary">
            <Card className="flex flex-col gap-2 p-4 text-[12px]">
              <p className="flex justify-between">
                <span className="text-faint">Assets</span>
                <span className="tabular">{project.assetCount}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-faint">Storage</span>
                <span className="tabular">{formatBytes(project.totalBytes)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-faint">Created</span>
                <span>{dateTime(project.createdAt)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-faint">Last activity</span>
                <span>{dateTime(project.updatedAt)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-faint">Your access</span>
                <span>{project.projectRoleKey ? project.projectRoleKey.replace("_", " ") : "via organization role"}</span>
              </p>
            </Card>
          </Section>
        </aside>
      </div>
    </div>
  );
}
