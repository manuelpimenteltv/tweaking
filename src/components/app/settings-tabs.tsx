import Link from "next/link";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/misc";

export function SettingsHeader({ orgSlug, active, perms }: { orgSlug: string; active: "general" | "members" | "roles" | "audit"; perms: { settings: boolean; members: boolean; audit: boolean } }) {
  const base = `/o/${orgSlug}/settings`;
  const tabs = [
    perms.settings && { key: "general", label: "General", href: base },
    { key: "members", label: "Members", href: `${base}/members` },
    { key: "roles", label: "Roles & permissions", href: `${base}/roles` },
    perms.audit && { key: "audit", label: "Audit log", href: `${base}/audit` },
  ].filter(Boolean) as { key: string; label: string; href: string }[];
  return (
    <>
      <PageHeader title="Administration" />
      <nav className="flex gap-4 border-b border-border px-6" aria-label="Administration sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active === t.key ? "page" : undefined}
            className={cn("-mb-px border-b-2 py-2 text-[13px]", active === t.key ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
