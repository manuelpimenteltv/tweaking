import { and, eq, sql } from "drizzle-orm";
import { systemDb, type Executor } from "../db/client";
import { processingJobs } from "../db/schema";

export type JobType = "ingest" | "proxy";

export type ClaimedJob = typeof processingJobs.$inferSelect;

/**
 * Enqueue inside the caller's transaction: the job exists if and only if the
 * change that requires it was committed.
 */
export async function enqueueJob(
  exec: Executor,
  job: { orgId: string; assetVersionId: string; type: JobType; requestedBy?: string | null; payload?: Record<string, unknown> },
) {
  const [row] = await exec
    .insert(processingJobs)
    .values({
      organizationId: job.orgId,
      assetVersionId: job.assetVersionId,
      type: job.type,
      requestedBy: job.requestedBy ?? null,
      payload: job.payload ?? {},
    })
    .returning();
  return row;
}

/**
 * Claims the next runnable job (queued and due, or running with an expired
 * lease after a worker crash). SKIP LOCKED lets many workers poll concurrently.
 */
export async function claimJob(workerId: string, leaseSeconds: number, types: JobType[]): Promise<ClaimedJob | null> {
  const res = await systemDb().execute<Record<string, unknown>>(sql`
    update processing_jobs set
      status = 'running',
      attempts = attempts + 1,
      locked_by = ${workerId},
      locked_until = now() + make_interval(secs => ${leaseSeconds}),
      started_at = coalesce(started_at, now())
    where id = (
      select id from processing_jobs
      where type in ${types}
        and ((status = 'queued' and run_after <= now()) or (status = 'running' and locked_until < now()))
      order by run_after
      for update skip locked
      limit 1)
    returning id`);
  const id = res.rows[0]?.id as string | undefined;
  if (!id) return null;
  const [job] = await systemDb().select().from(processingJobs).where(eq(processingJobs.id, id));
  return job ?? null;
}

export async function completeJob(jobId: string, workerId: string) {
  await systemDb()
    .update(processingJobs)
    .set({ status: "succeeded", finishedAt: new Date(), lockedUntil: null, lastError: null })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.lockedBy, workerId)));
}

/**
 * Records a failure. Retryable failures are rescheduled with exponential
 * backoff until max_attempts; returns true when the job is permanently failed.
 */
export async function failJob(job: ClaimedJob, workerId: string, error: string, retryable: boolean): Promise<boolean> {
  const final = !retryable || job.attempts >= job.maxAttempts;
  const backoffSeconds = Math.min(3600, 30 * 2 ** (job.attempts - 1));
  await systemDb()
    .update(processingJobs)
    .set(
      final
        ? { status: "failed", finishedAt: new Date(), lockedUntil: null, lastError: error.slice(0, 2000) }
        : { status: "queued", runAfter: sql`now() + make_interval(secs => ${backoffSeconds})`, lockedUntil: null, lastError: error.slice(0, 2000) },
    )
    .where(and(eq(processingJobs.id, job.id), eq(processingJobs.lockedBy, workerId)));
  return final;
}

/** Extends the lease of a long-running job (heartbeat). */
export async function heartbeat(jobId: string, workerId: string, leaseSeconds: number) {
  await systemDb()
    .update(processingJobs)
    .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})` })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.lockedBy, workerId)));
}
