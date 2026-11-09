"use client";

import { useState, useTransition } from "react";
import { acceptInviteAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";

export function AcceptInviteButton({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <FormError message={error} />
      <Button
        variant="primary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const res = await acceptInviteAction(token);
            if (res && !res.ok) setError(res.error.message);
          })
        }
      >
        Accept invitation
      </Button>
    </div>
  );
}
