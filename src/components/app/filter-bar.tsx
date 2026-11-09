import Link from "next/link";
import { cn } from "@/lib/cn";

/** Server-rendered segmented filter: each option is a real link carrying the URL state. */
export function FilterLinks({
  options,
  current,
  hrefFor,
  label,
}: {
  options: { value: string; label: string }[];
  current: string;
  hrefFor: (value: string) => string;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-md border border-border bg-surface-1 p-0.5">
      {options.map((o) => (
        <Link
          key={o.value}
          href={hrefFor(o.value)}
          aria-current={o.value === current ? "true" : undefined}
          className={cn(
            "rounded px-2 py-1 text-[12px] transition-colors",
            o.value === current ? "bg-surface-3 text-text" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export function withParams(base: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}
