/**
 * Input schemas shared by forms (client-side validation) and services
 * (authoritative server-side validation).
 */
import { z } from "zod";

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be at most ${max} characters.`);

export const uuid = z.uuid();
export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")).pipe(z.string().max(254));

export const signUpSchema = z.object({
  name: trimmed(1, 120, "Name"),
  email,
  password: z.string().min(10, "Use at least 10 characters.").max(256, "Password is too long."),
});

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password.").max(256),
});

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "3–48 characters: lowercase letters, numbers and dashes.");

export const RESERVED_SLUGS = new Set(["api", "admin", "app", "login", "signup", "invite", "onboarding", "new", "settings", "r", "o", "static", "_next"]);

export const createOrgSchema = z.object({
  name: trimmed(2, 80, "Studio name"),
  slug: slugSchema.refine((s) => !RESERVED_SLUGS.has(s), "This address is reserved."),
});

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #F2A93B.");

export const updateOrgSchema = z.object({
  name: trimmed(2, 80, "Studio name"),
  accentColor: hexColor.optional().or(z.literal("")),
  portalTitle: z.string().trim().max(80).optional(),
});

export const inviteSchema = z.object({
  email,
  roleId: uuid,
});

export const workspaceSchema = z.object({
  name: trimmed(1, 80, "Workspace name"),
  description: z.string().trim().max(500).default(""),
});

export const projectStatusValues = ["active", "on_hold", "completed", "archived"] as const;

const metadataEntries = z
  .array(z.object({ key: trimmed(1, 60, "Field name"), value: z.string().trim().max(500) }))
  .max(30, "At most 30 custom fields.");

export const projectSchema = z.object({
  name: trimmed(1, 120, "Project name"),
  description: z.string().trim().max(2000).default(""),
  workspaceId: uuid,
  status: z.enum(projectStatusValues).default("active"),
  clientName: z.string().trim().max(120).optional().default(""),
  clientEmail: z.union([z.literal(""), email]).optional().default(""),
  managerUserId: z.union([z.literal(""), uuid]).optional().default(""),
  metadata: metadataEntries.optional().default([]),
});

export const folderNameSchema = trimmed(1, 255, "Folder name").refine(
  (n) => !/[\\/\u0000-\u001f]/.test(n) && n !== "." && n !== "..",
  "Folder names can't contain slashes or control characters.",
);

export const assetNameSchema = trimmed(1, 255, "Name").refine((n) => !/[\u0000-\u001f]/.test(n), "Invalid characters.");

export const initiateUploadSchema = z.object({
  projectId: uuid,
  folderId: uuid.nullable().default(null),
  /** When set, the upload becomes a new version of this asset. */
  assetId: uuid.nullable().default(null),
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mimeType: z.string().max(255).default("application/octet-stream"),
  /** Optional client-computed fingerprint used to resume across reloads. */
  lastModified: z.number().int().nonnegative().optional(),
});

const base64Sha256 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "Invalid SHA-256 checksum.");

export const signPartsSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), checksumSha256: base64Sha256.optional() }))
    .min(1)
    .max(100),
});

export const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1).max(200),
        checksumSha256: base64Sha256.optional(),
      }),
    )
    .min(1)
    .max(10_000),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;
export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;

/** Flattens zod issues into { field: firstMessage } for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    out[key] ??= issue.message;
  }
  return out;
}
