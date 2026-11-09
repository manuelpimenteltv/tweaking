"use client";

import { Plus, X } from "lucide-react";
import { useState, useTransition } from "react";
import { deleteProjectAction, updateProjectAction } from "@/server/actions/org";
import { fieldErrors, projectSchema } from "@/lib/validation";
import { PROJECT_STATUS } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Card, Section } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

type ProjectData = {
  id: string;
  name: string;
  description: string;
  status: string;
  workspaceId: string;
  clientName: string;
  clientEmail: string;
  managerUserId: string;
  managerName: string;
  metadata: { key: string; value: string }[];
};

export function ProjectDetailsForm({
  orgSlug,
  project,
  workspaces,
  managers,
  editable,
}: {
  orgSlug: string;
  project: ProjectData;
  workspaces: { id: string; name: string }[];
  managers: { id: string; name: string }[];
  editable: boolean;
}) {
  const [meta, setMeta] = useState(project.metadata.length ? project.metadata : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const managerOptions = managers.some((m) => m.id === project.managerUserId) || !project.managerUserId
    ? managers
    : [...managers, { id: project.managerUserId, name: project.managerName }];

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const input = {
          name: fd.get("name"),
          description: fd.get("description"),
          status: fd.get("status"),
          workspaceId: fd.get("workspaceId"),
          clientName: fd.get("clientName"),
          clientEmail: fd.get("clientEmail"),
          managerUserId: fd.get("managerUserId") ?? "",
          metadata: meta.filter((m) => m.key.trim()),
        };
        const parsed = projectSchema.safeParse(input);
        if (!parsed.success) return setErrors(fieldErrors(parsed.error));
        setErrors({});
        start(async () => {
          const res = await updateProjectAction(orgSlug, project.id, parsed.data);
          if (res.ok) {
            setFormError(null);
            toast("Project saved", "success");
          } else {
            setFormError(res.error.message);
            setErrors(res.error.fieldErrors ?? {});
          }
        });
      }}
    >
      <fieldset disabled={!editable} className="flex flex-col gap-3">
        <FormError message={formError} />
        <Field label="Name" htmlFor="p-name" error={errors.name}>
          <Input id="p-name" name="name" defaultValue={project.name} aria-invalid={!!errors.name} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Status" htmlFor="p-status">
            <Select id="p-status" name="status" defaultValue={project.status}>
              {Object.entries(PROJECT_STATUS).map(([v, s]) => (
                <option key={v} value={v}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Workspace" htmlFor="p-ws">
            <Select id="p-ws" name="workspaceId" defaultValue={project.workspaceId}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project manager" htmlFor="p-pm" error={errors.managerUserId}>
            <Select id="p-pm" name="managerUserId" defaultValue={project.managerUserId}>
              <option value="">—</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client" htmlFor="p-client">
            <Input id="p-client" name="clientName" defaultValue={project.clientName} />
          </Field>
          <Field label="Client email" htmlFor="p-client-email" error={errors.clientEmail}>
            <Input id="p-client-email" name="clientEmail" type="email" defaultValue={project.clientEmail} aria-invalid={!!errors.clientEmail} />
          </Field>
        </div>
        <Field label="Description" htmlFor="p-desc">
          <Textarea id="p-desc" name="description" defaultValue={project.description} rows={3} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-muted">Custom fields</span>
          {meta.map((m, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label="Field name"
                placeholder="PO number"
                value={m.key}
                onChange={(e) => setMeta((all) => all.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                className="w-40"
              />
              <Input aria-label="Field value" placeholder="Value" value={m.value} onChange={(e) => setMeta((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              {editable && (
                <IconButton label="Remove field" onClick={() => setMeta((all) => all.filter((_, j) => j !== i))}>
                  <X size={14} />
                </IconButton>
              )}
            </div>
          ))}
          {errors.metadata && <p className="text-[12px] text-danger">{errors.metadata}</p>}
          {editable && meta.length < 30 && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setMeta((all) => [...all, { key: "", value: "" }])}>
              <Plus size={13} /> Add field
            </Button>
          )}
        </div>
      </fieldset>
      {editable && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={pending}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}

export function ProjectDangerZone({ orgSlug, projectId, name }: { orgSlug: string; projectId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Danger zone">
      <Card className="flex items-center justify-between gap-4 border-danger/30 p-4">
        <div>
          <p className="font-medium">Delete project</p>
          <p className="text-[12px] text-muted">Removes the project and its contents for everyone. Files remain recoverable by an administrator during the retention period.</p>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete project
        </Button>
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this project?"
        description={
          <>
            Type <span className="font-mono text-text">{name}</span> to confirm.
          </>
        }
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={typed !== name}
              loading={pending}
              onClick={() =>
                start(async () => {
                  const res = await deleteProjectAction(orgSlug, projectId);
                  if (res && !res.ok) setError(res.error.message);
                })
              }
            >
              Delete project
            </Button>
          </>
        }
      >
        <FormError message={error} />
        <Input aria-label="Project name" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Dialog>
    </Section>
  );
}
