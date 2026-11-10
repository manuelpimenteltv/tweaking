import { ChevronRight, CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AssetActions, RetryButton } from "@/components/app/asset-actions";
import { AutoRefresh } from "@/components/app/auto-refresh";
import { KindIcon } from "@/components/app/kind-icon";
import { Badge, Skeleton } from "@/components/ui/misc";
import { formatBytes, KIND_LABELS } from "@/lib/file-types";
import { dateTime, duration, frameRate, PROCESSING_STATUS, REVIEW_STATUS, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { getAsset } from "@/server/modules/assets";
import { listThreads } from "@/server/modules/review";
import { ReviewWorkspace } from "@/components/review/review-workspace";
import { VersionSwitcher } from "@/components/review/version-switcher";
import { requireOrg } from "@/server/next/session";

export default function AssetPage(props: PageProps<"/o/[org]/assets/[assetId]">) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-[60vh]" />}>
      <Asset {...props} />
    </Suspense>
  );
}

async function Asset({ params, searchParams }: PageProps<"/o/[org]/assets/[assetId]">) {
  const { org, assetId } = await params;
  const sp = await searchParams;
  const ctx = await requireOrg(org);
  const vParam = Number(Array.isArray(sp.v) ? sp.v[0] : sp.v);
  const data = await getAsset(ctx, assetId, Number.isInteger(vParam) && vParam > 0 ? vParam : undefined);
  const { asset, project, selected: v, versions, jobs, breadcrumbs, permissions } = data;
  const can = (p: string) => (permissions as string[]).includes(p);
  const info = v?.mediaInfo ?? {};
  const isCurrent = v?.id === asset.currentVersionId;
  const proc = v ? PROCESSING_STATUS[v.processingStatus] : null;
  const projectHref = `/o/${org}/projects/${project.id}`;

  const details = (
    <>
          {v && (
            <div className="flex flex-col gap-5 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                {proc && <Badge tone={proc.tone} dot>{proc.label}</Badge>}
                <Badge tone={REVIEW_STATUS[asset.reviewStatus]?.tone}>{REVIEW_STATUS[asset.reviewStatus]?.label}</Badge>
                <Badge>{KIND_LABELS[asset.kind as keyof typeof KIND_LABELS]}</Badge>
              </div>

              {v.processingStatus === "failed" && (
                <div className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[12px]">
                  <p className="flex items-center gap-1.5 font-medium text-danger">
                    <CircleAlert size={14} /> Processing failed
                  </p>
                  <p className="mt-1 text-muted">{v.processingError}</p>
                  {can("asset.processing_retry") && <RetryButton orgSlug={org} versionId={v.id} />}
                </div>
              )}
              {info.notes?.map((n) => (
                <p key={n} className="rounded-md bg-surface-2 p-2 text-[12px] text-muted">
                  {n}
                </p>
              ))}

              <Group title="File">
                <Row k="Original name" v={v.originalFilename} mono />
                <Row k="Size" v={`${formatBytes(v.sizeBytes, 2)} (${v.sizeBytes.toLocaleString()} bytes)`} />
                <Row k="Type" v={v.detectedMimeType ?? `${v.declaredMimeType} (unverified)`} mono />
                <Row k="Uploaded" v={v.uploadedAt ? `${dateTime(v.uploadedAt)} by ${v.uploaderName ?? "—"}` : "Upload in progress"} />
                <Row k="SHA-256" v={v.contentSha256 ? <span title={v.contentSha256}>{v.contentSha256.slice(0, 16)}…</span> : "Pending"} mono />
                <Row
                  k="Storage"
                  v={`${v.connectionName} · ${v.storageSource === "native" ? "stored by Loupe" : v.storageSource === "external_import" ? "imported" : "external reference"}`}
                />
              </Group>

              {(info.width || info.durationSec != null) && (
                <Group title="Media">
                  {info.width && info.height && <Row k="Resolution" v={`${info.width} × ${info.height}`} mono />}
                  {info.durationSec != null && <Row k="Duration" v={duration(info.durationSec)} mono />}
                  {info.fps && (
                    <Row
                      k="Frame rate"
                      v={
                        <>
                          {frameRate(info.fps)} fps <span className="text-faint">({info.fps.num}/{info.fps.den})</span>
                          {info.vfr && <Badge tone="warning" className="ml-1.5">VFR</Badge>}
                        </>
                      }
                      mono
                    />
                  )}
                  {info.startTimecode && <Row k="Start TC" v={info.startTimecode} mono />}
                  {info.videoCodec && <Row k="Video" v={[info.videoCodec, info.pixelFormat].filter(Boolean).join(" · ")} mono />}
                  {info.audioCodec && (
                    <Row k="Audio" v={[info.audioCodec, info.audioChannels && `${info.audioChannels} ch`, info.sampleRate && `${info.sampleRate / 1000} kHz`].filter(Boolean).join(" · ")} mono />
                  )}
                  {(info.colorSpace || info.colorTransfer) && <Row k="Color" v={[info.colorSpace, info.colorTransfer].filter(Boolean).join(" / ")} mono />}
                  {info.container && <Row k="Container" v={info.container} mono />}
                  {info.bitRate && <Row k="Bit rate" v={`${(info.bitRate / 1_000_000).toFixed(1)} Mb/s`} mono />}
                </Group>
              )}

              <Group title={`Versions (${versions.length})`}>
                <ol className="flex flex-col gap-1">
                  {versions.map((ver) => (
                    <li key={ver.id}>
                      <Link
                        href={`/o/${org}/assets/${asset.id}${ver.id === asset.currentVersionId ? "" : `?v=${ver.versionNumber}`}`}
                        aria-current={ver.id === v.id ? "true" : undefined}
                        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]", ver.id === v.id ? "bg-surface-3" : "hover:bg-surface-2")}
                      >
                        <span className="w-7 font-mono text-muted">v{ver.versionNumber}</span>
                        <span className="min-w-0 flex-1 truncate">{ver.originalFilename}</span>
                        {ver.id === asset.currentVersionId && <Badge tone="accent">Current</Badge>}
                        {ver.processingStatus !== "ready" && <Badge tone={PROCESSING_STATUS[ver.processingStatus]?.tone}>{PROCESSING_STATUS[ver.processingStatus]?.label}</Badge>}
                        <span className="text-faint">{timeAgo(ver.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </Group>

              {jobs.length > 0 && (
                <Group title="Processing history">
                  <ol className="flex flex-col gap-1 text-[12px]">
                    {jobs.map((j) => (
                      <li key={j.id} className="flex items-center gap-2">
                        <span className="font-mono text-muted">{j.type}</span>
                        <Badge tone={j.status === "succeeded" ? "success" : j.status === "failed" ? "danger" : "info"}>{j.status}</Badge>
                        <span className="text-faint">
                          attempt {j.attempts}/{j.maxAttempts}
                        </span>
                        <span className="ml-auto text-faint">{timeAgo(j.finishedAt ?? j.createdAt)}</span>
                      </li>
                    ))}
                  </ol>
                </Group>
              )}
            </div>
          )}
    </>
  );

  // Video review: needs the processed version with a frame rate, and a playable source
  // (review proxies preferred; a verified browser-playable original until they exist).
  const renditions = data.renditions.length ? data.renditions : data.playbackUrl ? [{ name: "Original", height: info.height ?? 0, url: data.playbackUrl }] : [];
  const reviewable = asset.kind === "video" && v?.processingStatus === "ready" && !!info.fps && !!info.durationSec && renditions.length > 0;
  const threads = reviewable && v ? await listThreads(ctx, v.id) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
        <nav aria-label="Location" className="flex min-w-0 flex-1 items-center gap-1 text-[12px] text-muted">
          <Link href={projectHref} className="truncate hover:text-text">
            {project.name}
          </Link>
          {breadcrumbs.map((b) => (
            <span key={b.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={12} className="text-faint" aria-hidden />
              <Link href={`${projectHref}?folder=${b.id}`} className="truncate hover:text-text">
                {b.name}
              </Link>
            </span>
          ))}
          <ChevronRight size={12} className="text-faint" aria-hidden />
          <h1 className="truncate text-[14px] font-semibold text-text">{asset.name}</h1>
          {v && (
            <VersionSwitcher
              current={v.versionNumber}
              latest={versions.find((x) => x.id === asset.currentVersionId)?.versionNumber ?? v.versionNumber}
              versions={versions.map((x) => ({ number: x.versionNumber, name: x.originalFilename, ready: x.processingStatus === "ready" }))}
            />
          )}
        </nav>
        <AssetActions
          orgSlug={org}
          projectId={project.id}
          asset={{ id: asset.id, name: asset.name, kind: asset.kind, folderId: asset.folderId }}
          versionId={v?.uploadedAt ? v.id : null}
          can={{
            download: can("asset.download"),
            version: can("asset.version"),
            delete: can("asset.delete"),
          }}
        />
      </header>

      {reviewable && v && threads ? (
        <ReviewWorkspace
          key={v.id}
          orgSlug={org}
          version={{ id: v.id, number: v.versionNumber, isCurrent }}
          media={{
            fps: info.fps!,
            startTimecode: info.startTimecode ?? null,
            durationSec: info.durationSec!,
            width: info.width ?? 1920,
            height: info.height ?? 1080,
            renditions: renditions.map((r) => ({ name: r.name, url: r.url })),
            posterUrl: data.posterUrl,
            sprite: data.sprite,
          }}
          initial={threads}
          canComment={can("comment.create")}
          currentUserId={ctx.userId}
          details={details}
        />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Viewer */}
        <section aria-label="Preview" className="relative grid min-h-[320px] flex-1 place-items-center bg-[#08080a] p-4">
          {v?.processingStatus === "ready" && data.playbackUrl && asset.kind === "video" ? (
            <video
              src={data.playbackUrl}
              poster={data.posterUrl ?? undefined}
              controls
              preload="metadata"
              className="max-h-full max-w-full"
              aria-label={`${asset.name} (version ${v.versionNumber})`}
            />
          ) : v?.processingStatus === "ready" && data.playbackUrl && asset.kind === "audio" ? (
            <audio src={data.playbackUrl} controls preload="metadata" className="w-full max-w-xl" />
          ) : data.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.posterUrl} alt={asset.name} className="max-h-full max-w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-3 text-center text-muted">
              <KindIcon kind={asset.kind} size={44} className="text-faint" />
              <p className="max-w-sm text-[13px]">
                {v?.processingStatus === "processing" || v?.processingStatus === "awaiting_upload"
                  ? "Processing… the preview will appear automatically."
                  : v?.processingStatus === "failed"
                    ? "This file couldn't be processed. See details on the right."
                    : asset.kind === "document" || asset.kind === "spreadsheet" || asset.kind === "presentation"
                      ? "In-browser page, sheet and slide previews are part of the document review module (Phase 3). The original is available for download."
                      : "No preview is available for this file type. The original is available for download."}
              </p>
            </div>
          )}
          {v?.processingStatus === "ready" && asset.kind === "video" && !data.playbackUrl && data.posterUrl && (
            <p className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-black/70 px-2.5 py-1.5 text-[12px] text-white/80">
              <Info size={13} />{" "}
              {data.proxyStatus === "failed"
                ? "The review proxy couldn’t be built. Retry from the processing history."
                : `${info.videoCodec?.toUpperCase()} can’t play in browsers. Preparing a review proxy…`}
            </p>
          )}
          {(v?.processingStatus === "processing" || v?.processingStatus === "awaiting_upload" || data.proxyStatus === "processing") && <AutoRefresh />}
        </section>

        {/* Inspector */}
        <aside className="w-full shrink-0 overflow-y-auto border-t border-border bg-surface-1 lg:w-[340px] lg:border-t-0 lg:border-l" aria-label="Details">
          {details}
        </aside>
      </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h2>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 text-[12px]">
      <dt className="text-faint">{k}</dt>
      <dd className={cn("min-w-0 break-words text-text", mono && "font-mono text-[11.5px]")}>{v}</dd>
    </div>
  );
}

