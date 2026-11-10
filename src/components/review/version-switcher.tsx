"use client";

import { useRouter } from "next/navigation";

/** Switches the viewed version. Each version keeps its own comments and drawings. */
export function VersionSwitcher({ current, latest, versions }: { current: number; latest: number; versions: { number: number; name: string; ready: boolean }[] }) {
  const router = useRouter();
  if (versions.length < 2) {
    return <span className="ml-1 rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">v{current}</span>;
  }
  return (
    <select
      aria-label="Version"
      value={current}
      onChange={(e) => {
        const n = Number(e.target.value);
        router.push(n === latest ? "?" : `?v=${n}`);
      }}
      className={`ml-1 h-6 rounded border px-1 text-[11px] font-medium ${current === latest ? "border-accent/40 bg-accent-soft text-accent" : "border-border-strong bg-surface-2 text-muted"}`}
    >
      {versions.map((v) => (
        <option key={v.number} value={v.number}>
          v{v.number}
          {v.number === latest ? " (current)" : ""} — {v.name}
          {v.ready ? "" : " · processing"}
        </option>
      ))}
    </select>
  );
}
