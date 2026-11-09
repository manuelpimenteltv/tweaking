export function timeAgo(date: Date | string | null | undefined, now = Date.now()): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en", { month: "short", day: "numeric", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export function dateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** 24000/1001 → "23.976", 25/1 → "25". */
export function frameRate(fps?: { num: number; den: number }): string {
  if (!fps) return "—";
  const v = fps.num / fps.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
}

export const PROJECT_STATUS: Record<string, { label: string; tone: "success" | "warning" | "info" | "neutral" }> = {
  active: { label: "Active", tone: "success" },
  on_hold: { label: "On hold", tone: "warning" },
  completed: { label: "Completed", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
};

export const REVIEW_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "accent" | "warning" | "success" | "danger" }> = {
  draft: { label: "Draft", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  ready_for_review: { label: "Ready for review", tone: "accent" },
  in_review: { label: "In review", tone: "accent" },
  changes_requested: { label: "Changes requested", tone: "danger" },
  approved: { label: "Approved", tone: "success" },
  final: { label: "Final", tone: "success" },
};

export const PROCESSING_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  awaiting_upload: { label: "Uploading", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const VERBS: Record<string, string> = {
  "org.created": "created the studio",
  "workspace.created": "created workspace",
  "project.created": "created project",
  "project.updated": "updated project",
  "project.deleted": "deleted project",
  "project.member_set": "set project access for",
  "folder.created": "created folder",
  "folder.renamed": "renamed folder to",
  "asset.uploaded": "uploaded",
  "asset.version_uploaded": "uploaded a new version of",
  "asset.renamed": "renamed asset to",
  "items.moved": "moved items to",
  "items.deleted": "deleted items from",
  "member.joined": "joined",
};
export function activityVerb(verb: string, data: Record<string, unknown>): string {
  if (verb === "asset.version_uploaded" && data.version) return `uploaded v${data.version} of`;
  if (verb === "items.moved" || verb === "items.deleted") {
    const parts = [data.assets ? `${data.assets} asset${data.assets === 1 ? "" : "s"}` : null, data.folders ? `${data.folders} folder${data.folders === 1 ? "" : "s"}` : null].filter(Boolean);
    return `${verb === "items.moved" ? "moved" : "deleted"} ${parts.join(" and ") || "items"} ${verb === "items.moved" ? "to" : "from"}`;
  }
  return VERBS[verb] ?? verb;
}
