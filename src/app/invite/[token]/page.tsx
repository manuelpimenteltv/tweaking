import { Aperture, MailWarning } from "lucide-react";
import { Suspense } from "react";
import { AcceptInviteButton } from "@/components/app/accept-invite";
import { LinkButton } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { previewInvitation } from "@/server/modules/members";
import { getCurrentUser } from "@/server/next/session";

export const metadata = { title: "Invitation" };

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <Aperture size={22} className="mb-6 text-accent" aria-hidden />
        <Suspense fallback={<Skeleton className="h-32" />}>
          <Invite params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Invite({ params }: Pick<PageProps<"/invite/[token]">, "params">) {
  const { token } = await params;
  const [invite, user] = await Promise.all([previewInvitation(token), getCurrentUser()]);
  if (!invite || invite.status !== "valid") {
    return (
      <div className="flex flex-col gap-3">
        <MailWarning className="text-warning" />
        <h1 className="text-[18px] font-semibold">This invitation can&apos;t be used</h1>
        <p className="text-muted">
          {invite?.status === "expired"
            ? "It has expired."
            : invite?.status === "accepted"
              ? "It has already been accepted."
              : "It was revoked or the link is incorrect."}{" "}
          Ask the person who invited you for a new link.
        </p>
      </div>
    );
  }
  const next = `/invite/${token}`;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">Join {invite.orgName}</h1>
        <p className="mt-1 text-muted">
          You were invited as <span className="text-text">{invite.roleName}</span>
          {invite.projectName ? (
            <>
              {" "}on the project <span className="text-text">{invite.projectName}</span>
            </>
          ) : null}
          . This invitation is for <span className="font-mono text-text">{invite.email}</span>.
        </p>
      </div>
      {user ? (
        user.email === invite.email ? (
          <AcceptInviteButton token={token} />
        ) : (
          <p className="rounded-md border border-warning/30 bg-warning-soft p-3 text-[12px] text-warning">
            You&apos;re signed in as {user.email}. Sign out and sign in as {invite.email} to accept.
          </p>
        )
      ) : (
        <div className="flex gap-2">
          <LinkButton variant="primary" href={`/signup?next=${encodeURIComponent(next)}`}>
            Create account
          </LinkButton>
          <LinkButton href={`/login?next=${encodeURIComponent(next)}`}>Sign in</LinkButton>
        </div>
      )}
    </div>
  );
}
