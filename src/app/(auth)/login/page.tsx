import { Suspense } from "react";
import { SignInForm } from "@/components/app/auth-forms";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="mb-1 text-[20px] font-semibold tracking-tight">Sign in</h1>
      <p className="mb-6 text-muted">Welcome back to your studio.</p>
      <Suspense>
        <SignInForm />
      </Suspense>
    </>
  );
}
