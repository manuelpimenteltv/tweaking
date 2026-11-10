/**
 * File-type policy shared by the uploader (client pre-validation) and the server
 * (authoritative validation). The ingest worker additionally verifies the real
 * content with magic-byte detection (src/server/jobs/ingest.ts).
 */
export type AssetKind = "video" | "audio" | "image" | "document" | "spreadsheet" | "presentation" | "archive" | "other";

const KIND_BY_EXTENSION: Record<string, AssetKind> = {
  // Video
  mp4: "video", m4v: "video", mov: "video", mxf: "video", mkv: "video", webm: "video", avi: "video",
  mpg: "video", mpeg: "video", m2ts: "video", mts: "video", ts: "video", "3gp": "video", r3d: "video", braw: "video",
  // Audio
  wav: "audio", aif: "audio", aiff: "audio", mp3: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio", opus: "audio",
  // Images
  jpg: "image", jpeg: "image", png: "image", tif: "image", tiff: "image", webp: "image", gif: "image", heic: "image",
  avif: "image", bmp: "image", psd: "image", exr: "image", dpx: "image", svg: "image",
  // Documents
  pdf: "document", doc: "document", docx: "document", rtf: "document", txt: "document", md: "document",
  odt: "document", pages: "document", fdx: "document", ai: "document",
  // Spreadsheets
  xls: "spreadsheet", xlsx: "spreadsheet", csv: "spreadsheet", ods: "spreadsheet", numbers: "spreadsheet", tsv: "spreadsheet",
  // Presentations
  ppt: "presentation", pptx: "presentation", odp: "presentation", key: "presentation",
  // Archives / project files
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  drp: "other", prproj: "other", aep: "other", fcpxml: "other", xml: "other", edl: "other", aaf: "other",
  cube: "other", srt: "other", vtt: "other", scc: "other", stl: "other",
};

/** Executables and active content are rejected outright, whatever their declared type. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "cpl", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1",
  "sh", "bash", "zsh", "app", "dmg", "pkg", "deb", "rpm", "apk", "jar", "dll", "so", "dylib", "html", "htm",
  "xhtml", "svgz", "hta", "lnk", "reg", "php", "py", "rb", "pl",
]);

/** Image formats every current browser displays natively. Others get a large WebP review copy. */
export const BROWSER_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export const KIND_LABELS: Record<AssetKind, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  archive: "Archive",
  other: "Other",
};

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function kindForExtension(ext: string): AssetKind {
  return KIND_BY_EXTENSION[ext.toLowerCase()] ?? "other";
}

export type FileCheck = { ok: true; kind: AssetKind; extension: string } | { ok: false; reason: string };

export function checkUploadable(filename: string, size: number, maxBytes: number): FileCheck {
  const name = filename.trim();
  if (!name || name.length > 255) return { ok: false, reason: "File name must be 1–255 characters." };
  const extension = extensionOf(name);
  if (BLOCKED_EXTENSIONS.has(extension)) return { ok: false, reason: `.${extension} files are not allowed for security reasons.` };
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, reason: "File is empty." };
  if (size > maxBytes) return { ok: false, reason: `File exceeds the ${formatBytes(maxBytes)} upload limit.` };
  return { ok: true, kind: kindForExtension(extension), extension };
}

/**
 * Declared MIME types come from the browser and are advisory. We only reject
 * blatant contradictions (e.g. "video.mp4" declared as text/html).
 */
export function declaredMimeIsPlausible(kind: AssetKind, mime: string): boolean {
  const m = mime.toLowerCase();
  if (!m || m === "application/octet-stream") return true;
  if (m.includes("html") || m.includes("javascript") || m === "application/x-msdownload") return false;
  switch (kind) {
    case "video":
      return m.startsWith("video/") || m === "application/mxf" || m.startsWith("application/");
    case "audio":
      return m.startsWith("audio/") || m.startsWith("video/");
    case "image":
      return m.startsWith("image/") || m.startsWith("application/");
    default:
      return true;
  }
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}
