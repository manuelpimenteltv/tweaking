import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { uuid } from "@/lib/validation";
import type { AuthContext } from "../authz/context";
import { requireProject } from "../authz/project-access";
import { assetVersions, assets, processingJobs } from "../db/schema";
import { withTenant } from "../db/tenant";
import { conflict, notFound } from "../errors";
import { enqueueJob, type JobType } from "../jobs/queue";
import { parse } from "../lib/validate";
import { auditFromCtx, recordAudit } from "./audit";

/** Re-runs ingest for a failed version. Authorized users only (asset.processing_retry). */
export async function retryProcessing(ctx: AuthContext, versionId: string) {
  parse(uuid, versionId);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ projectId: assets.projectId, status: assetVersions.processingStatus, uploadedAt: assetVersions.uploadedAt })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(and(eq(assetVersions.id, versionId), isNull(assets.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Version");
    await requireProject(tx, ctx, row.projectId, "asset.processing_retry");
    if (!row.uploadedAt) throw conflict("This file hasn't finished uploading.");
    const active = await tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(and(eq(processingJobs.assetVersionId, versionId), inArray(processingJobs.status, ["queued", "running"])));
    if (active.length) throw conflict("Processing is already queued.");
    let type: JobType;
    if (row.status === "failed") {
      type = "ingest";
      await tx.update(assetVersions).set({ processingStatus: "processing", processingError: null }).where(eq(assetVersions.id, versionId));
    } else {
      // A ready version whose most recent proxy job failed can rebuild just its review proxy.
      const [lastProxy] = await tx
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(and(eq(processingJobs.assetVersionId, versionId), eq(processingJobs.type, "proxy")))
        .orderBy(desc(processingJobs.createdAt))
        .limit(1);
      if (lastProxy?.status !== "failed") throw conflict("Only failed processing can be retried.");
      type = "proxy";
    }
    const job = await enqueueJob(tx, { orgId: ctx.orgId, assetVersionId: versionId, type, requestedBy: ctx.userId });
    await recordAudit(tx, auditFromCtx(ctx, "processing.retried", { type: "asset_version", id: versionId }, { job: type }));
    return job;
  });
}
