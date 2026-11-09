import Link from "next/link";
import { activityVerb, timeAgo } from "@/lib/format";
import { Avatar } from "@/components/ui/misc";

type Item = {
  id: string;
  verb: string;
  subjectType: string;
  subjectId: string | null;
  subjectName: string;
  data: Record<string, unknown>;
  createdAt: Date;
  projectId: string | null;
  projectName: string | null;
  actorName: string | null;
};

export function ActivityList({ items, orgSlug, compact }: { items: Item[]; orgSlug: string; compact?: boolean }) {
  if (!items.length) return <p className="text-[12px] text-faint">No activity yet.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {items.map((a) => {
        const href =
          a.subjectType === "asset" && a.subjectId
            ? `/o/${orgSlug}/assets/${a.subjectId}`
            : a.subjectType === "folder" && a.subjectId && a.projectId
              ? `/o/${orgSlug}/projects/${a.projectId}?folder=${a.subjectId}`
              : a.projectId
                ? `/o/${orgSlug}/projects/${a.projectId}`
                : null;
        const name = a.subjectName || a.projectName || "";
        return (
          <li key={a.id} className="flex gap-2.5 text-[12px]">
            <Avatar name={a.actorName ?? "System"} size={20} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-muted">
                <span className="text-text">{a.actorName ?? "System"}</span> {activityVerb(a.verb, a.data)}{" "}
                {href && a.verb !== "project.deleted" ? (
                  <Link href={href} className="text-text hover:underline">
                    {name}
                  </Link>
                ) : (
                  <span className="text-text">{name}</span>
                )}
                {!compact || !a.projectName || a.subjectType === "project" ? null : <span className="text-faint"> in {a.projectName}</span>}
              </p>
              <p className="text-[11px] text-faint">{timeAgo(a.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
