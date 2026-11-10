import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { PermanentJobError, markVersionFailed, runIngest } from "./ingest";
import { runProxy } from "./proxy";
import { claimJob, completeJob, failJob, heartbeat, type ClaimedJob, type JobType } from "./queue";

const HANDLERS: Record<JobType, (job: ClaimedJob, signal: AbortSignal) => Promise<void>> = {
  ingest: runIngest,
  proxy: runProxy,
};

export const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const LEASE_SECONDS = 120;

/**
 * Claims and runs one job. Returns false when the queue is empty.
 * Exported separately so tests can drive the queue deterministically.
 */
export async function runOnce(id = workerId): Promise<boolean> {
  const job = await claimJob(id, LEASE_SECONDS, Object.keys(HANDLERS) as JobType[]);
  if (!job) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env().WORKER_JOB_TIMEOUT_SECONDS * 1000);
  const beat = setInterval(() => heartbeat(job.id, id, LEASE_SECONDS).catch(() => undefined), (LEASE_SECONDS / 3) * 1000);
  const started = Date.now();
  try {
    await HANDLERS[job.type as JobType](job, controller.signal);
    await completeJob(job.id, id);
    log("info", "job succeeded", { jobId: job.id, type: job.type, ms: Date.now() - started });
  } catch (err) {
    const permanent = err instanceof PermanentJobError;
    const message = permanent ? (err as Error).message : errorMessage(err);
    const final = await failJob(job, id, message, !permanent && !controller.signal.aborted);
    // A failed proxy leaves the version usable (download, metadata); only ingest failures fail the version.
    if (final && job.type === "ingest") {
      await markVersionFailed(job, permanent ? message : `Processing failed after ${job.attempts} attempts: ${message}`, permanent ? (err as PermanentJobError).versionFields : {});
    }
    log(final ? "error" : "warn", final ? "job failed" : "job will retry", { jobId: job.id, type: job.type, attempt: job.attempts, error: message });
  } finally {
    clearTimeout(timeout);
    clearInterval(beat);
  }
  return true;
}

/** Error message including the driver-level cause (Drizzle wraps PostgreSQL errors). */
export function errorMessage(err: unknown): string {
  const e = err as Error & { cause?: Error };
  return e?.cause?.message ? `${e.message.split("\n")[0]} — ${e.cause.message}` : (e?.message ?? String(err));
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), worker: workerId, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
