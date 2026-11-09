"use client";

import { useState, useTransition } from "react";
import { updateOrgAction } from "@/server/actions/org";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

export function OrgSettingsForm({ orgSlug, initial }: { orgSlug: string; initial: { name: string; slug: string; accentColor: string; portalTitle: string } }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState(initial.accentColor || "#F2A93B");
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await updateOrgAction(orgSlug, { name: fd.get("name"), accentColor: fd.get("accentColor"), portalTitle: fd.get("portalTitle") });
          if (res.ok) {
            setErrors({});
            setError(null);
            toast("Settings saved", "success");
          } else {
            setError(res.error.fieldErrors ? null : res.error.message);
            setErrors(res.error.fieldErrors ?? {});
          }
        });
      }}
    >
      <FormError message={error} />
      <Field label="Studio name" htmlFor="org-name" error={errors.name}>
        <Input id="org-name" name="name" defaultValue={initial.name} />
      </Field>
      <Field label="Studio address" htmlFor="org-slug" hint="The address can't be changed after creation, so existing links keep working.">
        <Input id="org-slug" value={`/o/${initial.slug}`} readOnly disabled className="font-mono" />
      </Field>
      <div className="border-t border-border pt-4">
        <p className="mb-3 text-[12px] font-semibold tracking-wide text-muted uppercase">Client portal branding</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accent color" htmlFor="org-accent" error={errors.accentColor} hint="Used on client review portals (Phase 4).">
            <div className="flex gap-2">
              <input type="color" aria-label="Pick accent color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="h-8 w-10 rounded border border-border-strong bg-surface-2" />
              <Input id="org-accent" name="accentColor" value={color} onChange={(e) => setColor(e.target.value)} className="font-mono" />
            </div>
          </Field>
          <Field label="Portal title" htmlFor="org-portal" error={errors.portalTitle}>
            <Input id="org-portal" name="portalTitle" defaultValue={initial.portalTitle} placeholder={initial.name} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
