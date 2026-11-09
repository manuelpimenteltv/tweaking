import Link from "next/link";
import { Badge } from "@/components/ui/misc";
import { PROJECT_STATUS } from "@/lib/format";
import { cn } from "@/lib/cn";
import { FavoriteButton } from "./project-actions";

export function ProjectHeader({
  orgSlug,
  project,
  tab,
  canManage,
}: {
  orgSlug: string;
  project: { id: string; name: string; status: string; clientName: string | null; workspaceName: string; isFavorite: boolean };
  tab: "files" | "activity" | "settings";
  canManage: boolean;
}) {
  const base = `/o/${orgSlug}/projects/${project.id}`;
  const tabs = [
    { key: "files", label: "Files", href: base },
    { key: "activity", label: "Activity", href: `${base}/activity` },
    { key: "settings", label: canManage ? "Settings & people" : "Details & people", href: `${base}/settings` },
  ];
  const status = PROJECT_STATUS[project.status];
  return (
    <header className="border-b border-border px-6 pt-4">
      <div className="flex items-center gap-2 text-[12px] text-faint">
        <Link href={`/o/${orgSlug}/projects`} className="hover:text-text">
          Projects
        </Link>
        <span aria-hidden>/</span>
        <span>{project.workspaceName}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <h1 className="truncate text-[18px] font-semibold tracking-tight">{project.name}</h1>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
        <FavoriteButton orgSlug={orgSlug} projectId={project.id} favorite={project.isFavorite} />
        {project.clientName && <span className="ml-1 text-[12px] text-muted">for {project.clientName}</span>}
      </div>
      <nav className="mt-3 flex gap-4" aria-label="Project sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn("-mb-px border-b-2 pb-2 text-[13px]", tab === t.key ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
