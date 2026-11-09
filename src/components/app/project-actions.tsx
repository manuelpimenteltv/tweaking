"use client";

import { Plus, Star } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { createProjectAction, setFavoriteAction } from "@/server/actions/org";
import { projectSchema, fieldErrors } from "@/lib/validation";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

export function FavoriteButton({ orgSlug, projectId, favorite, overlay }: { orgSlug: string; projectId: string; favorite: boolean; overlay?: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(favorite);
  const [, start] = useTransition();
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={optimistic ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={optimistic}
      title={optimistic ? "Remove from favorites" : "Add to favorites"}
      onClick={() =>
        start(async () => {
          setOptimistic(!optimistic);
          const res = await setFavoriteAction(orgSlug, projectId, !optimistic);
          if (!res.ok) toast(res.error.message, "error");
        })
      }
      className={cn(
        "grid size-7 place-items-center rounded-md transition-colors",
        overlay ? "bg-black/50 backdrop-blur-sm" : "hover:bg-surface-3",
        optimistic ? "text-accent" : overlay ? "text-white/70 opacity-0 group-hover:opacity-100 focus:opacity-100" : "text-faint",
      )}
    >
      <Star size={14} fill={optimistic ? "currentColor" : "none"} />
    </button>
  );
}

export function NewProjectButton({ orgSlug, workspaces, defaultWorkspaceId }: { orgSlug: string; workspaces: { id: string; name: string }[]; defaultWorkspaceId?: string }) {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const input = {
      name: fd.get("name"),
      workspaceId: fd.get("workspaceId"),
      clientName: fd.get("clientName"),
      clientEmail: fd.get("clientEmail"),
      description: fd.get("description"),
      status: "active",
    };
    const parsed = projectSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    start(async () => {
      const res = await createProjectAction(orgSlug, parsed.data);
      if (res && !res.ok) {
        setFormError(res.error.message);
        setErrors(res.error.fieldErrors ?? {});
      }
    });
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus size={14} /> New project
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="new-project" loading={pending}>
              Create project
            </Button>
          </>
        }
      >
        <form
          id="new-project"
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(e.currentTarget);
          }}
        >
          <FormError message={formError} />
          <Field label="Project name" htmlFor="np-name" error={errors.name}>
            <Input id="np-name" name="name" autoFocus required placeholder="Spring Campaign — 30s Spot" aria-invalid={!!errors.name} />
          </Field>
          <Field label="Workspace" htmlFor="np-ws" error={errors.workspaceId}>
            <Select id="np-ws" name="workspaceId" defaultValue={defaultWorkspaceId ?? workspaces[0]?.id}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client" htmlFor="np-client" error={errors.clientName}>
              <Input id="np-client" name="clientName" placeholder="Optional" />
            </Field>
            <Field label="Client email" htmlFor="np-client-email" error={errors.clientEmail}>
              <Input id="np-client-email" name="clientEmail" type="email" placeholder="Optional" aria-invalid={!!errors.clientEmail} />
            </Field>
          </div>
          <Field label="Description" htmlFor="np-desc" error={errors.description}>
            <Textarea id="np-desc" name="description" rows={3} placeholder="Deliverables, specs, deadlines…" />
          </Field>
        </form>
      </Dialog>
    </>
  );
}
