import "server-only";
import { forbidden } from "next/navigation";
import { can, type AuthContext } from "../authz/context";

export function settingsPerms(ctx: AuthContext) {
  return { settings: can(ctx, "org.manage_settings"), members: can(ctx, "org.manage_members"), audit: can(ctx, "org.view_audit_log") };
}

/** Administration is for people with at least one admin capability. */
export function requireAdmin(ctx: AuthContext) {
  const p = settingsPerms(ctx);
  if (!p.settings && !p.members && !p.audit) forbidden();
  return p;
}
