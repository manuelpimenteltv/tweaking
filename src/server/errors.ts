export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "quota_exceeded"
  | "storage_error"
  | "internal";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
  get status(): number {
    return {
      unauthenticated: 401,
      forbidden: 403,
      not_found: 404,
      validation: 422,
      conflict: 409,
      rate_limited: 429,
      quota_exceeded: 413,
      storage_error: 502,
      internal: 500,
    }[this.code];
  }
}

export const unauthenticated = (m = "You need to sign in.") => new AppError("unauthenticated", m);
export const forbidden = (m = "You don't have permission to do that.") => new AppError("forbidden", m);
export const notFound = (what = "Resource") => new AppError("not_found", `${what} not found.`);
export const conflict = (m: string, fieldErrors?: Record<string, string>) => new AppError("conflict", m, fieldErrors);
export const invalid = (m: string, fieldErrors?: Record<string, string>) => new AppError("validation", m, fieldErrors);

/** PostgreSQL unique_violation → friendly conflict. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const pgErr = e as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && (!constraint || pgErr.constraint === constraint);
}
