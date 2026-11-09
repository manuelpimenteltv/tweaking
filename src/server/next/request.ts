import "server-only";
import { headers } from "next/headers";
import type { RequestMeta } from "../authz/context";

/**
 * Client IP from the first X-Forwarded-For hop. Only trustworthy behind a proxy
 * that overwrites the header (CDN / load balancer); see docs/SECURITY.md.
 */
export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff || h.get("x-real-ip") || null;
  return { ip: ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null, userAgent: h.get("user-agent") };
}
