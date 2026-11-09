import type { z } from "zod";
import { fieldErrors } from "@/lib/validation";
import { invalid } from "../errors";

/** Server-side validation: never trust client-side checks. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const errors = fieldErrors(result.error);
    throw invalid(Object.values(errors)[0] ?? "Invalid input.", errors);
  }
  return result.data;
}
