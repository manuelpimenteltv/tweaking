"use client";

import { Copy, UserPlus, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import {
  inviteToProjectAction,
  listAssignableMembersAction,
  removeProjectMemberAction,
  upsertProjectMemberAction,
} from "@/server/actions/org";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

const PROJECT_ROLES = [
  { key: "project_manager", label: "Project Manager" },
  { key: "editor", label: "Editor" },
  { key: "reviewer", label: "Reviewer" },
  { key: "client", label: "Client" },
  { key: "guest", label: "Guest" },
] as const;

/** Mirrors the server's PROJECT_ROLE_CEILING for UI hints; the server enforces it. */
const CEILING: Record<string, string[]> = {
  owner: ["project_manager", "editor", "reviewer", "client", "guest"],
  admin: ["project_manager", "editor", "reviewer", "client", "guest"],
  project_manager: ["project_manager", "editor", "reviewer", "client", "guest"],
  editor: ["editor", "reviewer", "guest"],
  reviewer: ["reviewer", "guest"],
  client: ["client", "guest"],
  guest: ["guest"],
};

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  orgRoleKey: string | null;
  orgRoleName: string | null;
};

export function ProjectMembers({
  orgSlug,
  projectId,
  members,
  canManage,
  canInviteManagers,
  currentUserId,
}: {
  orgSlug: string;
  projectId: string;
  members: Member[];
  canManage: boolean;
  canInviteManagers: boolean;
  currentUserId: string;
}) {
  const toast = useToast();
  const [, start] = useTransition();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-1">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <Avatar name={m.name} size={26} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px]">
                {m.name} {m.userId === currentUserId && <span className="text-faint">(you)</span>}
              </p>
              <p className="truncate text-[11px] text-faint">
                {m.email} · {m.orgRoleName ?? "—"} in studio
              </p>
            </div>
            {canManage ? (
              <Select
                aria-label={`Project role for ${m.name}`}
                className="h-7 w-40 text-[12px]"
                value={m.roleKey}
                onChange={(e) =>
                  start(async () => {
                    const res = await upsertProjectMemberAction(orgSlug, { projectId, userId: m.userId, roleKey: e.target.value });
                    toast(res.ok ? "Role updated" : res.error.message, res.ok ? "success" : "error");
                  })
                }
              >
                {PROJECT_ROLES.filter((r) => (CEILING[m.orgRoleKey ?? "guest"] ?? ["guest"]).includes(r.key)).map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="text-[12px] text-muted">{m.roleName}</span>
            )}
            {canManage && (
              <IconButton
                label={`Remove ${m.name} from project`}
                onClick={() =>
                  start(async () => {
                    const res = await removeProjectMemberAction(orgSlug, { projectId, userId: m.userId });
                    toast(res.ok ? `${m.name} removed` : res.error.message, res.ok ? "success" : "error");
                  })
                }
              >
                <X size={14} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <>
          <Button size="sm" className="self-start" onClick={() => setAdding(true)}>
            <UserPlus size={13} /> Add people
          </Button>
          {adding && (
            <AddPeopleDialog orgSlug={orgSlug} projectId={projectId} canInviteManagers={canInviteManagers} onClose={() => setAdding(false)} />
          )}
        </>
      )}
    </div>
  );
}

function AddPeopleDialog({ orgSlug, projectId, canInviteManagers, onClose }: { orgSlug: string; projectId: string; canInviteManagers: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"existing" | "invite">("existing");
  const [candidates, setCandidates] = useState<{ userId: string; name: string; email: string; orgRoleKey: string }[] | null>(null);
  const [userId, setUserId] = useState("");
  const [roleKey, setRoleKey] = useState("editor");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("client");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  useEffect(() => {
    listAssignableMembersAction(orgSlug, projectId).then((r) => setCandidates(r.ok ? r.data : []));
  }, [orgSlug, projectId]);
  const selected = candidates?.find((c) => c.userId === userId);
  const allowed = PROJECT_ROLES.filter((r) => (CEILING[selected?.orgRoleKey ?? "guest"] ?? []).includes(r.key));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add people to this project"
      width={480}
      footer={
        link ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={mode === "existing" ? !userId : !email}
              onClick={() =>
                start(async () => {
                  setError(null);
                  if (mode === "existing") {
                    const res = await upsertProjectMemberAction(orgSlug, { projectId, userId, roleKey: allowed.some((r) => r.key === roleKey) ? roleKey : allowed[0]?.key });
                    if (res.ok) {
                      toast("Added to project", "success");
                      onClose();
                    } else setError(res.error.message);
                  } else {
                    const res = await inviteToProjectAction(orgSlug, { projectId, email, projectRoleKey: inviteRole });
                    if (res.ok) setLink(res.data.url);
                    else setError(res.error.message);
                  }
                })
              }
            >
              {mode === "existing" ? "Add" : "Create invitation"}
            </Button>
          </>
        )
      }
    >
      {link ? (
        <InviteLink url={link} email={email} />
      ) : (
        <div className="flex flex-col gap-3">
          <div role="tablist" className="flex gap-1 rounded-md border border-border p-0.5 text-[12px]">
            {(["existing", "invite"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 py-1 ${mode === m ? "bg-surface-3 text-text" : "text-muted"}`}
              >
                {m === "existing" ? "Studio member" : "Invite by email"}
              </button>
            ))}
          </div>
          <FormError message={error} />
          {mode === "existing" ? (
            <>
              <Field label="Person" htmlFor="add-user">
                <Select id="add-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">{candidates === null ? "Loading…" : candidates.length ? "Choose a member" : "Everyone is already on this project"}</option>
                  {candidates?.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.name} — {c.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Project role" htmlFor="add-role" hint={selected ? "Limited by their studio role." : undefined}>
                <Select id="add-role" value={allowed.some((r) => r.key === roleKey) ? roleKey : allowed[0]?.key} onChange={(e) => setRoleKey(e.target.value)} disabled={!selected}>
                  {allowed.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Email" htmlFor="inv-email">
                <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@agency.com" autoFocus />
              </Field>
              <Field label="Role" htmlFor="inv-role" hint="Clients and guests only see projects they're added to.">
                <Select id="inv-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  {PROJECT_ROLES.filter((r) => r.key !== "project_manager" || canInviteManagers).map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function InviteLink({ url, email }: { url: string; email: string }) {
  const toast = useToast();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-muted">
        Share this link with <span className="text-text">{email}</span>. It works only for that email address and expires in 7 days.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            toast("Link copied", "success");
          }}
        >
          <Copy size={13} /> Copy
        </Button>
      </div>
      <p className="text-[11px] text-faint">Email delivery isn&apos;t configured on this server yet, so share the link yourself.</p>
    </div>
  );
}
