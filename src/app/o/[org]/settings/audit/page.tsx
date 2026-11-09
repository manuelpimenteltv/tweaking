import { forbidden } from "next/navigation";
import { Suspense } from "react";
import { SettingsHeader } from "@/components/app/settings-tabs";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { dateTime } from "@/lib/format";
import { listAuditLog } from "@/server/modules/audit";
import { requireAdmin } from "@/server/next/settings";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Audit log" };

export default function AuditPage(props: PageProps<"/o/[org]/settings/audit">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Audit {...props} />
    </Suspense>
  );
}

async function Audit({ params, searchParams }: PageProps<"/o/[org]/settings/audit">) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requireOrg(org);
  const perms = requireAdmin(ctx);
  if (!perms.audit) forbidden();
  const beforeRaw = Array.isArray(sp.before) ? sp.before[0] : sp.before;
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : undefined;
  const entries = await listAuditLog(ctx, { before, limit: 100 });
  const last = entries.at(-1);
  return (
    <>
      <SettingsHeader orgSlug={org} active="audit" perms={perms} />
      <div className="p-6">
        {entries.length ? (
          <>
            <table className="w-full text-left text-[12px]">
              <thead className="text-[11px] tracking-wide text-faint uppercase">
                <tr className="border-b border-border">
                  <th className="py-2 font-medium">Time</th>
                  <th className="py-2 font-medium">Actor</th>
                  <th className="py-2 font-medium">Action</th>
                  <th className="py-2 font-medium">Details</th>
                  <th className="py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted">{dateTime(e.createdAt)}</td>
                    <td className="py-1.5 pr-3">{e.actorName ?? "System"}</td>
                    <td className="py-1.5 pr-3 font-mono">{e.action}</td>
                    <td className="max-w-md truncate py-1.5 pr-3 font-mono text-[11px] text-muted" title={JSON.stringify(e.data)}>
                      {Object.keys(e.data ?? {}).length ? JSON.stringify(e.data) : ""}
                    </td>
                    <td className="py-1.5 font-mono text-faint">{e.ip ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length === 100 && last && (
              <a className="mt-4 inline-block text-[12px] text-muted hover:text-text" href={`/o/${org}/settings/audit?before=${encodeURIComponent(last.createdAt.toISOString())}`}>
                Older entries →
              </a>
            )}
          </>
        ) : (
          <EmptyState title="No audit events yet" />
        )}
      </div>
    </>
  );
}
