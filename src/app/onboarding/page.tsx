import { Aperture } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { CreateOrgForm } from "@/components/app/auth-forms";
import { Skeleton } from "@/components/ui/misc";
import { listMyOrganizations } from "@/server/modules/organizations";
import { requireUser } from "@/server/next/session";

export const metadata = { title: "Create a studio" };

export default function OnboardingPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <Aperture size={22} className="mb-6 text-accent" aria-hidden />
        <h1 className="mb-1 text-[20px] font-semibold tracking-tight">Create your studio</h1>
        <p className="mb-6 text-muted">A studio holds your projects, team, storage and client reviews. You can invite people next.</p>
        <Suspense fallback={<Skeleton className="h-40" />}>
          <Existing />
        </Suspense>
        <CreateOrgForm />
      </div>
    </main>
  );
}

async function Existing() {
  const user = await requireUser("/onboarding");
  const orgs = await listMyOrganizations(user.id);
  if (!orgs.length) return null;
  return (
    <div className="mb-6 rounded-lg border border-border bg-surface-1 p-3">
      <p className="mb-2 text-[12px] text-muted">Your studios</p>
      <ul className="flex flex-col gap-1">
        {orgs.map((o) => (
          <li key={o.id}>
            <Link href={`/o/${o.slug}`} className="flex justify-between rounded px-2 py-1.5 hover:bg-surface-3">
              <span>{o.name}</span>
              <span className="text-faint">{o.roleName}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
