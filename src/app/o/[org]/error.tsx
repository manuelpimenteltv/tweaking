"use client";

import { Button } from "@/components/ui/button";

export default function OrgError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-[50dvh] place-items-center p-6 text-center">
      <div>
        <h1 className="text-[16px] font-semibold">Something went wrong</h1>
        <p className="mt-1 text-[13px] text-muted">The error was logged{error.digest ? ` (ref ${error.digest})` : ""}. Try again, or reload the page.</p>
        <Button className="mt-4" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
