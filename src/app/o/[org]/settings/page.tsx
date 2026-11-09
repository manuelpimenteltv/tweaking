import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OrgSettingsForm } from "@/components/app/org-settings";
import { SettingsHeader } from "@/components/app/settings-tabs";
import { Card, Skeleton } from "@/components/ui/misc";
import { getOrganization } from "@/server/modules/organizations";
import { requireAdmin } from "@/server/next/settings";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Administration" };

export default function SettingsPage({ params }: PageProps<"/o/[org]/settings">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <General params={params} />
    </Suspense>
  );
}

async function General({ params }: Pick<PageProps<"/o/[org]/settings">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const perms = requireAdmin(ctx);
  if (!perms.settings) redirect(`/o/${org}/settings/members`);
  const o = await getOrganization(ctx);
  return (
    <>
      <SettingsHeader orgSlug={org} active="general" perms={perms} />
      <div className="max-w-2xl p-6">
        <Card className="p-4">
          <OrgSettingsForm orgSlug={org} initial={{ name: o.name, slug: o.slug, accentColor: o.branding.accentColor ?? "", portalTitle: o.branding.portalTitle ?? "" }} />
        </Card>
      </div>
    </>
  );
}
