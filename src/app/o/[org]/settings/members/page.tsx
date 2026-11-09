import { Suspense } from "react";
import { MembersAdmin } from "@/components/app/members-admin";
import { SettingsHeader } from "@/components/app/settings-tabs";
import { Skeleton } from "@/components/ui/misc";
import { listMembers, listOrgRoles, listPendingInvitations } from "@/server/modules/members";
import { requireAdmin } from "@/server/next/settings";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Members" };

export default function MembersPage({ params }: PageProps<"/o/[org]/settings/members">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Members params={params} />
    </Suspense>
  );
}

async function Members({ params }: Pick<PageProps<"/o/[org]/settings/members">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const perms = requireAdmin(ctx);
  const [members, roles, invites] = await Promise.all([listMembers(ctx), listOrgRoles(ctx), listPendingInvitations(ctx)]);
  return (
    <>
      <SettingsHeader orgSlug={org} active="members" perms={perms} />
      <MembersAdmin
        orgSlug={org}
        canManage={perms.members}
        isOwner={ctx.role.key === "owner"}
        currentUserId={ctx.userId}
        members={members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))}
        roles={roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description }))}
        invites={invites.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }))}
      />
    </>
  );
}
