import { Check } from "lucide-react";
import { Suspense } from "react";
import { SettingsHeader } from "@/components/app/settings-tabs";
import { Section, Skeleton } from "@/components/ui/misc";
import { ORG_PERMISSIONS, PERMISSION_LABELS, PROJECT_PERMISSIONS, type Permission } from "@/server/authz/permissions";
import { listOrgRoles, listProjectRoles } from "@/server/modules/members";
import { requireAdmin } from "@/server/next/settings";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Roles & permissions" };

export default function RolesPage({ params }: PageProps<"/o/[org]/settings/roles">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Roles params={params} />
    </Suspense>
  );
}

async function Roles({ params }: Pick<PageProps<"/o/[org]/settings/roles">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const perms = requireAdmin(ctx);
  const [orgRoles, projectRoles] = await Promise.all([listOrgRoles(ctx), listProjectRoles(ctx)]);
  return (
    <>
      <SettingsHeader orgSlug={org} active="roles" perms={perms} />
      <div className="flex flex-col gap-8 p-6">
        <p className="max-w-3xl text-[13px] text-muted">
          Studio roles grant organization-wide abilities. Owners and Administrators can access every project. Everyone else gets project abilities through
          their project role, which can never exceed their studio role (a Client can only be a Client or Guest on a project). Every permission is enforced
          on the server. Custom roles arrive with the collaboration module (Phase 4).
        </p>
        <Matrix title="Studio roles" roles={orgRoles} permissions={ORG_PERMISSIONS} />
        <Matrix title="Project roles" roles={projectRoles} permissions={PROJECT_PERMISSIONS} />
      </div>
    </>
  );
}

function Matrix({ title, roles, permissions }: { title: string; roles: { id: string; name: string; permissions: string[] }[]; permissions: readonly Permission[] }) {
  return (
    <Section title={title}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-1">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <tr key={p} className="border-t border-border">
                <td className="px-3 py-1.5">
                  {PERMISSION_LABELS[p]} <span className="ml-1 font-mono text-[10px] text-faint">{p}</span>
                </td>
                {roles.map((r) => (
                  <td key={r.id} className="px-3 py-1.5 text-center">
                    {r.permissions.includes(p) ? <Check size={14} className="inline text-success" aria-label="Allowed" /> : <span className="text-faint" aria-label="Not allowed">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
