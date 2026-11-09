import { Suspense } from "react";
import { SignUpForm } from "@/components/app/auth-forms";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <>
      <h1 className="mb-1 text-[20px] font-semibold tracking-tight">Create your account</h1>
      <p className="mb-6 text-muted">Set up a studio or join one you were invited to.</p>
      <Suspense>
        <SignUpForm />
      </Suspense>
    </>
  );
}
