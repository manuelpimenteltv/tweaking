import { Suspense } from "react";
import { Sidebar } from "@/components/app/sidebar";
import { UploadProvider } from "@/components/app/uploader";
import { Skeleton } from "@/components/ui/misc";
import { ToastProvider } from "@/components/ui/toast";
import { can } from "@/server/authz/context";
import { listMyOrganizations } from "@/server/modules/organizations";
import { requireOrg } from "@/server/next/session";

export default function OrgLayout({ children, params }: LayoutProps<"/o/[org]">) {
  return (
    <ToastProvider>
      <UploadProvider>
        <div className="flex h-dvh overflow-hidden">
          <Suspense fallback={<SidebarSkeleton />}>
            <SidebarData params={params} />
          </Suspense>
          <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </UploadProvider>
    </ToastProvider>
  );
}

async function SidebarData({ params }: Pick<LayoutProps<"/o/[org]">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const orgs = await listMyOrganizations(ctx.userId);
  return (
    <Sidebar
      org={{ slug: ctx.orgSlug, name: ctx.orgName, roleName: ctx.role.name }}
      orgs={orgs.map((o) => ({ slug: o.slug, name: o.name }))}
      user={{ name: ctx.userName, email: ctx.userEmail }}
      nav={{
        internal: can(ctx, "org.view_internal"),
        storage: can(ctx, "org.manage_storage"),
        admin: can(ctx, "org.manage_members") || can(ctx, "org.manage_settings") || can(ctx, "org.view_audit_log"),
      }}
    />
  );
}

function SidebarSkeleton() {
  return (
    <aside className="flex w-[232px] shrink-0 flex-col gap-3 border-r border-border bg-surface-1 p-3">
      <Skeleton className="h-8" />
      <Skeleton className="h-7" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-6 w-3/4" />
      ))}
    </aside>
  );
}
