"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { createOrgAction, signInAction, signUpAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";

export function SignInForm() {
  const next = useSearchParams().get("next") ?? "";
  const [state, action, pending] = useActionState(signInAction, null);
  const err = state && !state.ok ? state.error : null;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError message={err && !err.fieldErrors ? err.message : err?.code === "unauthenticated" || err?.code === "rate_limited" ? err.message : null} />
      <Field label="Email" htmlFor="email" error={err?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus aria-invalid={!!err?.fieldErrors?.email} />
      </Field>
      <Field label="Password" htmlFor="password" error={err?.fieldErrors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!err?.fieldErrors?.password} />
      </Field>
      <Button type="submit" variant="primary" loading={pending} className="mt-1">
        Sign in
      </Button>
      <p className="text-center text-[12px] text-muted">
        New to Loupe?{" "}
        <Link className="text-text underline-offset-2 hover:underline" href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}>
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const next = useSearchParams().get("next") ?? "";
  const [state, action, pending] = useActionState(signUpAction, null);
  const err = state && !state.ok ? state.error : null;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError message={err && !err.fieldErrors ? err.message : null} />
      <Field label="Full name" htmlFor="name" error={err?.fieldErrors?.name}>
        <Input id="name" name="name" autoComplete="name" required autoFocus aria-invalid={!!err?.fieldErrors?.name} />
      </Field>
      <Field label="Work email" htmlFor="email" error={err?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={!!err?.fieldErrors?.email} />
      </Field>
      <Field label="Password" htmlFor="password" error={err?.fieldErrors?.password} hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required aria-invalid={!!err?.fieldErrors?.password} />
      </Field>
      <Button type="submit" variant="primary" loading={pending} className="mt-1">
        Create account
      </Button>
      <p className="text-center text-[12px] text-muted">
        Already have an account?{" "}
        <Link className="text-text underline-offset-2 hover:underline" href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrgAction, null);
  const err = state && !state.ok ? state.error : null;
  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      noValidate
      onInput={(e) => {
        const form = e.currentTarget;
        const name = form.elements.namedItem("name") as HTMLInputElement;
        const slug = form.elements.namedItem("slug") as HTMLInputElement;
        if (e.target === name && !slug.dataset.touched) {
          slug.value = name.value
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48);
        }
        if (e.target === slug) slug.dataset.touched = "1";
      }}
    >
      <FormError message={err && !err.fieldErrors ? err.message : null} />
      <Field label="Studio name" htmlFor="name" error={err?.fieldErrors?.name}>
        <Input id="name" name="name" required autoFocus placeholder="Northlight Post" aria-invalid={!!err?.fieldErrors?.name} />
      </Field>
      <Field label="Studio address" htmlFor="slug" error={err?.fieldErrors?.slug} hint="Used in links: /o/your-studio">
        <Input id="slug" name="slug" required pattern="[a-z0-9-]{3,48}" className="font-mono" aria-invalid={!!err?.fieldErrors?.slug} />
      </Field>
      <Button type="submit" variant="primary" loading={pending}>
        Create studio
      </Button>
    </form>
  );
}
