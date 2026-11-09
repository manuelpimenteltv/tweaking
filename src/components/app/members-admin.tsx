"use client";

import { UserPlus, X } from "lucide-react";
import { useState, useTransition } from "react";
import { changeMemberRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from "@/server/actions/org";
import { timeAgo } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Avatar, Badge, Section } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { InviteLink } from "./project-members";

type Member = { id: string; userId: string; name: string; email: string; status: string; roleId: string; roleKey: string; roleName: string; joinedAt: string };
type Role = { id: string; key: string; name: string; description: string };
type Invite = { id: string; email: string; roleName: string; projectName: string | null; expiresAt: string; createdAt: string };

export function MembersAdmin({
  orgSlug,
  canManage,
  isOwner,
  currentUserId,
  members,
  roles,
  invites,
}: {
  orgSlug: string;
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string;
  members: Member[];
  roles: Role[];
  invites: Invite[];
}) {
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const assignable = roles.filter((r) => r.key !== "owner" || isOwner);

  return (
    <div className="flex max-w-4xl flex-col gap-8 p-6">
      <Section
        title={`Members (${members.length})`}
        action={
          canManage && (
            <Button size="sm" variant="primary" onClick={() => setInviting(true)}>
              <UserPlus size={13} /> Invite
            </Button>
          )
        }
      >
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
          {members.map((m) => {
            const locked = !canManage || (m.roleKey === "owner" && !isOwner);
            return (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={m.name} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {m.name} {m.userId === currentUserId && <span className="text-faint">(you)</span>}
                    {m.status !== "active" && <Badge tone="warning" className="ml-2">{m.status}</Badge>}
                  </p>
                  <p className="truncate text-[11px] text-faint">
                    {m.email} · joined {timeAgo(m.joinedAt)}
                  </p>
                </div>
                {locked ? (
                  <span className="text-[12px] text-muted">{m.roleName}</span>
                ) : (
                  <Select
                    aria-label={`Role for ${m.name}`}
                    className="h-7 w-44 text-[12px]"
                    value={m.roleId}
                    onChange={(e) =>
                      start(async () => {
                        const res = await changeMemberRoleAction(orgSlug, { memberId: m.id, roleId: e.target.value });
                        toast(res.ok ? `${m.name}'s role updated` : res.error.message, res.ok ? "success" : "error");
                      })
                    }
                  >
                    {(m.roleKey === "owner" ? roles : assignable).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
                {!locked && m.userId !== currentUserId && (
                  <IconButton label={`Remove ${m.name}`} onClick={() => setRemoving(m)}>
                    <X size={14} />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={`Pending invitations (${invites.length})`}>
        {invites.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <span className="text-[12px] text-muted">
                  {i.roleName}
                  {i.projectName ? ` · ${i.projectName}` : ""}
                </span>
                <span className="text-[12px] text-faint">sent {timeAgo(i.createdAt)}</span>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      start(async () => {
                        const res = await revokeInvitationAction(orgSlug, i.id);
                        toast(res.ok ? "Invitation revoked" : res.error.message, res.ok ? "success" : "error");
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-faint">No pending invitations.</p>
        )}
      </Section>

      {inviting && <InviteDialog orgSlug={orgSlug} roles={assignable} onClose={() => setInviting(false)} />}
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        description="They lose access to this studio and all its projects immediately. Their uploads stay."
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                removing &&
                start(async () => {
                  const res = await removeMemberAction(orgSlug, removing.id);
                  toast(res.ok ? `${removing.name} removed` : res.error.message, res.ok ? "success" : "error");
                  setRemoving(null);
                })
              }
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}

function InviteDialog({ orgSlug, roles, onClose }: { orgSlug: string; roles: Role[]; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(roles.find((r) => r.key === "editor")?.id ?? roles[0]?.id);
  const [error, setError] = useState<{ message: string; fieldErrors?: Record<string, string> } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const role = roles.find((r) => r.id === roleId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite to studio"
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
              onClick={() =>
                start(async () => {
                  const res = await inviteMemberAction(orgSlug, { email, roleId });
                  if (res.ok) setLink(res.data.url);
                  else setError(res.error);
                })
              }
            >
              Create invitation
            </Button>
          </>
        )
      }
    >
      {link ? (
        <InviteLink url={link} email={email} />
      ) : (
        <div className="flex flex-col gap-3">
          <FormError message={error && !error.fieldErrors ? error.message : null} />
          <Field label="Email" htmlFor="invite-email" error={error?.fieldErrors?.email}>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="name@studio.com" />
          </Field>
          <Field label="Role" htmlFor="invite-role" hint={role?.description}>
            <Select id="invite-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
