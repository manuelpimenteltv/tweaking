import { Suspense } from "react";
import { AssetBrowser } from "@/components/app/asset-browser";
import { ProjectHeader } from "@/components/app/project-header";
import { Skeleton } from "@/components/ui/misc";
import { listFolderContents } from "@/server/modules/assets";
import { getProject } from "@/server/modules/projects";
import { requireOrg } from "@/server/next/session";

export default function ProjectPage(props: PageProps<"/o/[org]/projects/[projectId]">) {
  return (
    <Suspense fallback={<BrowserSkeleton />}>
      <Project {...props} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T => (allowed.find((a) => a === v) ?? fallback);

async function Project({ params, searchParams }: PageProps<"/o/[org]/projects/[projectId]">) {
  const { org, projectId } = await params;
  const sp = await searchParams;
  const ctx = await requireOrg(org);
  const view = {
    folder: one(sp.folder) ?? null,
    sort: pick(one(sp.sort), ["name", "date", "size", "type"] as const, "name"),
    dir: pick(one(sp.dir), ["asc", "desc"] as const, "asc"),
    kind: one(sp.kind),
    layout: pick(one(sp.view), ["grid", "list"] as const, "grid"),
  };
  const kind = (["video", "audio", "image", "document", "spreadsheet", "presentation", "archive", "other"] as const).find((k) => k === view.kind);
  const [project, contents] = await Promise.all([
    getProject(ctx, projectId),
    listFolderContents(ctx, { projectId, folderId: view.folder, sort: view.sort, dir: view.dir, kind }),
  ]);
  return (
    <div className="flex h-full flex-col">
      <ProjectHeader orgSlug={org} project={project} tab="files" canManage={project.permissions.includes("project.edit")} />
      <AssetBrowser
        key={view.folder ?? "root"}
        orgSlug={org}
        project={{ id: project.id, name: project.name }}
        folder={contents.folder ? { id: contents.folder.id, name: contents.folder.name, parentId: contents.folder.parentId } : null}
        breadcrumbs={contents.breadcrumbs}
        folders={contents.folders}
        assets={contents.assets.map((a) => ({
          id: a.id,
          currentVersionId: a.currentVersionId,
          name: a.name,
          kind: a.kind,
          reviewStatus: a.reviewStatus,
          versionNumber: a.versionNumber,
          versionCount: a.versionCount,
          extension: a.extension,
          sizeBytes: a.sizeBytes,
          processingStatus: a.processingStatus,
          durationSec: a.mediaInfo?.durationSec,
          width: a.mediaInfo?.width,
          height: a.mediaInfo?.height,
          uploaderName: a.uploaderName,
          createdAt: a.createdAt.toISOString(),
          previewUrl: a.previewUrl,
        }))}
        permissions={project.permissions}
        view={{ sort: view.sort, dir: view.dir, kind: kind ?? null, layout: view.layout }}
      />
    </div>
  );
}

function BrowserSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="mb-6 h-10 w-80" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="aspect-[4/3]" />
        ))}
      </div>
    </div>
  );
}
