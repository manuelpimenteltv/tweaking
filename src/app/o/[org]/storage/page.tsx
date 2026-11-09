import { HardDrive } from "lucide-react";
import { Suspense } from "react";
import { Badge, Card, PageHeader, Progress, Section, Skeleton } from "@/components/ui/misc";
import { formatBytes, KIND_LABELS } from "@/lib/file-types";
import { dateTime } from "@/lib/format";
import { listStorageConnections, storageAnalytics, storageSummary } from "@/server/modules/storage-usage";
import { requireOrg } from "@/server/next/session";

export const metadata = { title: "Storage" };

export default function StoragePage({ params }: PageProps<"/o/[org]/storage">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Storage params={params} />
    </Suspense>
  );
}

async function Storage({ params }: Pick<PageProps<"/o/[org]/storage">, "params">) {
  const { org } = await params;
  const ctx = await requireOrg(org);
  const [summary, analytics, connections] = await Promise.all([storageSummary(ctx), storageAnalytics(ctx), listStorageConnections(ctx)]);
  const max = (rows: { bytes: number }[]) => Math.max(1, ...rows.map((r) => r.bytes));

  return (
    <>
      <PageHeader title="Storage" description="Usage across projects, people and storage providers." />
      <div className="flex flex-col gap-8 p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Original files" value={formatBytes(summary.originalBytes)} hint={`${summary.fileCount} files`} />
          <Stat label="Generated previews" value={formatBytes(summary.derivedBytes)} hint="Thumbnails, posters, proxies" />
          <Stat label="In trash" value={formatBytes(summary.trashBytes)} hint="Deleted, awaiting retention purge" />
          <Stat label="Uploads in progress" value={formatBytes(analytics.pendingUploads.bytes)} hint={`${analytics.pendingUploads.count} sessions`} />
        </div>
        {summary.quotaBytes != null && (
          <Card className="p-4">
            <p className="mb-2 text-[12px] text-muted">
              {formatBytes(summary.originalBytes)} of {formatBytes(summary.quotaBytes)} quota used
            </p>
            <Progress value={(summary.originalBytes / summary.quotaBytes) * 100} />
          </Card>
        )}

        <Section title="Storage providers">
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
            {connections.map((c) => {
              const usage = analytics.byConnection.find((b) => b.id === c.id);
              return (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <HardDrive size={16} className="text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {c.name} {c.isDefault && <Badge tone="accent">Default</Badge>}
                    </p>
                    <p className="text-[12px] text-faint">
                      {c.providerName} · verified {dateTime(c.lastVerifiedAt)}
                    </p>
                  </div>
                  <Badge tone={c.status === "active" ? "success" : "danger"} dot>
                    {c.status.replace("_", " ")}
                  </Badge>
                  <span className="w-24 text-right tabular">{formatBytes(usage?.bytes ?? 0)}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] text-faint">
            Connecting Google Drive, Dropbox and your own S3 buckets is part of the hybrid storage module (Phase 5); see docs/ARCHITECTURE.md §11.
          </p>
        </Section>

        <div className="grid gap-8 lg:grid-cols-3">
          <Breakdown title="By project" rows={analytics.byProject.map((p) => ({ key: p.id, label: p.deleted ? `${p.name} (deleted)` : p.name, bytes: p.bytes, files: p.files }))} max={max(analytics.byProject)} />
          <Breakdown title="By uploader" rows={analytics.byUser.map((u) => ({ key: u.id, label: u.name, bytes: u.bytes, files: u.files }))} max={max(analytics.byUser)} />
          <Breakdown title="By type" rows={analytics.byKind.map((k) => ({ key: k.kind, label: KIND_LABELS[k.kind as keyof typeof KIND_LABELS] ?? k.kind, bytes: k.bytes, files: k.files }))} max={max(analytics.byKind)} />
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="p-4">
      <p className="text-[12px] text-muted">{label}</p>
      <p className="mt-1 text-[20px] font-semibold tabular">{value}</p>
      <p className="text-[11px] text-faint">{hint}</p>
    </Card>
  );
}

function Breakdown({ title, rows, max }: { title: string; rows: { key: string; label: string; bytes: number; files: number }[]; max: number }) {
  return (
    <Section title={title}>
      {rows.length ? (
        <ul className="flex flex-col gap-2.5">
          {rows.slice(0, 12).map((r) => (
            <li key={r.key} className="text-[12px]">
              <div className="mb-1 flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 text-muted tabular">
                  {formatBytes(r.bytes)} · {r.files}
                </span>
              </div>
              <div className="h-1 rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${(r.bytes / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-faint">No data yet.</p>
      )}
    </Section>
  );
}
