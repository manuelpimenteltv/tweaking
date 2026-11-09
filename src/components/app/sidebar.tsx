"use client";

import {
  Aperture,
  ChevronsUpDown,
  FolderKanban,
  HardDrive,
  House,
  Layers,
  LogOut,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOutAction } from "@/server/actions/auth";
import { cn } from "@/lib/cn";
import { Avatar, Kbd } from "@/components/ui/misc";
import { MenuList } from "@/components/ui/menu";

type Props = {
  org: { slug: string; name: string; roleName: string };
  orgs: { slug: string; name: string }[];
  user: { name: string; email: string };
  nav: { internal: boolean; storage: boolean; admin: boolean };
};

export function Sidebar({ org, orgs, user, nav }: Props) {
  const base = `/o/${org.slug}`;
  const router = useRouter();
  const search = useRef<HTMLInputElement>(null);
  const [orgMenu, setOrgMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const orgBtn = useRef<HTMLButtonElement>(null);
  const userBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.cookie = `loupe_last_org=${org.slug}; path=/; max-age=31536000; samesite=lax`;
  }, [org.slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const links = [
    nav.internal && { href: base, label: "Home", icon: House, exact: true },
    nav.internal && { href: `${base}/workspaces`, label: "Workspaces", icon: Layers },
    { href: `${base}/projects`, label: "Projects", icon: FolderKanban },
    { href: `${base}/shared`, label: "Shared with me", icon: Users },
    nav.storage && { href: `${base}/storage`, label: "Storage", icon: HardDrive },
    nav.admin && { href: `${base}/settings`, label: "Administration", icon: Settings },
  ].filter(Boolean) as { href: string; label: string; icon: typeof House; exact?: boolean }[];

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-border bg-surface-1" aria-label="Main navigation">
      <div className="p-2">
        <button
          ref={orgBtn}
          type="button"
          onClick={() => setOrgMenu((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={orgMenu}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3"
        >
          <span className="grid size-6 place-items-center rounded bg-accent-soft text-accent">
            <Aperture size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">{org.name}</span>
            <span className="block truncate text-[11px] text-faint">{org.roleName}</span>
          </span>
          <ChevronsUpDown size={14} className="text-faint" />
        </button>
        {orgMenu && (
          <MenuList
            anchor={orgBtn}
            align="start"
            onClose={() => setOrgMenu(false)}
            items={[
              ...orgs.map((o) => ({
                label: o.name,
                icon: o.slug === org.slug ? <span className="size-1.5 rounded-full bg-accent" /> : undefined,
                onSelect: () => router.push(`/o/${o.slug}`),
              })),
              { type: "separator" as const },
              { label: "Create a studio", icon: <Plus size={14} />, onSelect: () => router.push("/onboarding") },
            ]}
          />
        )}
      </div>

      <form
        role="search"
        className="px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          const q = search.current?.value.trim() ?? "";
          router.push(`${base}/search${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        }}
      >
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-faint focus-within:border-accent">
          <Search size={14} aria-hidden />
          <input ref={search} name="q" placeholder="Search" aria-label="Search projects, folders, assets and people" className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint" />
          <Kbd>/</Kbd>
        </label>
      </form>

      <nav className="flex flex-col gap-0.5 px-2 py-1">
        {links.map((l) => (
          <NavLink key={l.href} {...l} />
        ))}
      </nav>

      <div className="mt-auto border-t border-border p-2">
        <button
          ref={userBtn}
          type="button"
          onClick={() => setUserMenu((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={userMenu}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3"
        >
          <Avatar name={user.name} size={22} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px]">{user.name}</span>
            <span className="block truncate text-[11px] text-faint">{user.email}</span>
          </span>
        </button>
        {userMenu && (
          <MenuList
            anchor={userBtn}
            align="start"
            onClose={() => setUserMenu(false)}
            items={[{ label: "Sign out", icon: <LogOut size={14} />, onSelect: () => void signOutAction() }]}
          />
        )}
      </div>
    </aside>
  );
}

function NavLink({ href, label, icon: Icon, exact }: { href: string; label: string; icon: typeof House; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
        active ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon size={15} className={active ? "text-accent" : undefined} aria-hidden />
      {label}
    </Link>
  );
}
