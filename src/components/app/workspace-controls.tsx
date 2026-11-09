"use client";

import { Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { createWorkspaceAction, deleteWorkspaceAction, updateWorkspaceAction } from "@/server/actions/org";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { MenuList } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";

function WorkspaceDialog({
  title,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: { name: string; description: string };
  onClose: () => void;
  onSubmit: (v: { name: string; description: string }) => Promise<{ message: string; fieldErrors?: Record<string, string> } | null>;
}) {
  const [err, setErr] = useState<{ message: string; fieldErrors?: Record<string, string> } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="ws-form" loading={pending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="ws-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          start(async () => {
            const r = await onSubmit({ name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? "") });
            if (r) setErr(r);
            else onClose();
          });
        }}
      >
        <FormError message={err && !err.fieldErrors ? err.message : null} />
        <Field label="Name" htmlFor="ws-name" error={err?.fieldErrors?.name}>
          <Input id="ws-name" name="name" defaultValue={initial?.name} autoFocus required />
        </Field>
        <Field label="Description" htmlFor="ws-desc">
          <Textarea id="ws-desc" name="description" defaultValue={initial?.description} rows={2} />
        </Field>
      </form>
    </Dialog>
  );
}

export function NewWorkspaceButton({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus size={14} /> New workspace
      </Button>
      {open && (
        <WorkspaceDialog
          title="New workspace"
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            const r = await createWorkspaceAction(orgSlug, v);
            return r.ok ? null : r.error;
          }}
        />
      )}
    </>
  );
}

export function WorkspaceControls({ orgSlug, workspace, canDelete }: { orgSlug: string; workspace: { id: string; name: string; description: string }; canDelete: boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [, start] = useTransition();
  const toast = useToast();
  return (
    <>
      <IconButton ref={btn} label={`Actions for ${workspace.name}`} onClick={() => setMenu((m) => !m)}>
        <Ellipsis size={14} />
      </IconButton>
      {menu && (
        <MenuList
          anchor={btn}
          onClose={() => setMenu(false)}
          items={[
            { label: "Edit", icon: <Pencil size={13} />, onSelect: () => setEditing(true) },
            ...(canDelete
              ? [
                  {
                    label: "Delete",
                    icon: <Trash2 size={13} />,
                    danger: true,
                    onSelect: () =>
                      start(async () => {
                        const r = await deleteWorkspaceAction(orgSlug, workspace.id);
                        toast(r.ok ? "Workspace deleted" : r.error.message, r.ok ? "success" : "error");
                      }),
                  },
                ]
              : []),
          ]}
        />
      )}
      {editing && (
        <WorkspaceDialog
          title="Edit workspace"
          initial={workspace}
          onClose={() => setEditing(false)}
          onSubmit={async (v) => {
            const r = await updateWorkspaceAction(orgSlug, workspace.id, v);
            return r.ok ? null : r.error;
          }}
        />
      )}
    </>
  );
}
