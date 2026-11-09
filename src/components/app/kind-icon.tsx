import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "lucide-react";
import type { AssetKind } from "@/lib/file-types";

const ICONS = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  other: File,
} as const;

export function KindIcon({ kind, size = 16, className }: { kind: AssetKind | string; size?: number; className?: string }) {
  const Icon = ICONS[kind as AssetKind] ?? File;
  return <Icon size={size} className={className} aria-hidden />;
}

/** Thumbnail with a typed fallback; the image URL is a short-lived signed URL. */
export function Thumb({ url, kind, alt, className }: { url: string | null; kind: string; alt: string; className?: string }) {
  return (
    <div className={`relative grid place-items-center overflow-hidden bg-surface-3 ${className ?? ""}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs bypass the image optimizer by design
        <img src={url} alt={alt} loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain" draggable={false} />
      ) : (
        <KindIcon kind={kind} size={28} className="text-faint" />
      )}
    </div>
  );
}
