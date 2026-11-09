import { AppError } from "../errors";

export type ActionError = { code: string; message: string; fieldErrors?: Record<string, string> };
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: ActionError };

/** Maps any thrown error to a safe, user-facing shape. Internal errors are logged, never leaked. */
export function toActionError(err: unknown): ActionError {
  if (err instanceof AppError) return { code: err.code, message: err.message, fieldErrors: err.fieldErrors };
  console.error("[unexpected]", err);
  return { code: "internal", message: "Something went wrong. Please try again." };
}

export async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    // Let Next.js control-flow errors (redirect/notFound) propagate.
    if (isNextControlFlow(err)) throw err;
    return { ok: false, error: toActionError(err) };
  }
}

export function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: string })?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest === "NEXT_NOT_FOUND");
}
