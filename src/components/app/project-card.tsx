import { FolderKanban } from "lucide-react";
import Link from "next/link";
import { PROJECT_STATUS, timeAgo } from "@/lib/format";
import { Badge } from "@/components/ui/misc";
import { FavoriteButton } from "./project-actions";

export type ProjectCardData = {
  id: string;
  name: string;
  status: string;
  clientName: string | null;
  workspaceName: string;
  updatedAt: Date;
  assetCount: number;
  isFavorite: boolean;
  coverUrl: string | null;
};

export function ProjectCard({ p, orgSlug }: { p: ProjectCardData; orgSlug: string }) {
  const status = PROJECT_STATUS[p.status];
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-surface-1 transition-colors hover:border-border-strong">
      <Link href={`/o/${orgSlug}/projects/${p.id}`} className="block">
        <div className="relative aspect-video bg-surface-2">
          {p.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.coverUrl} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
          ) : (
            <div className="grid size-full place-items-center text-faint">
              <FolderKanban size={26} aria-hidden />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
            {status && p.status !== "active" && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-faint">
            <span className="truncate">{p.clientName || p.workspaceName}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular">{p.assetCount} asset{p.assetCount === 1 ? "" : "s"}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{timeAgo(p.updatedAt)}</span>
          </div>
        </div>
      </Link>
      <div className="absolute top-2 right-2">
        <FavoriteButton orgSlug={orgSlug} projectId={p.id} favorite={p.isFavorite} overlay />
      </div>
    </div>
  );
}

export function ProjectGrid({ projects, orgSlug }: { projects: ProjectCardData[]; orgSlug: string }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {projects.map((p) => (
        <ProjectCard key={p.id} p={p} orgSlug={orgSlug} />
      ))}
    </div>
  );
}
