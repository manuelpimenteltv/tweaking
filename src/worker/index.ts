/**
 * Processing worker. Runs separately from the web app (pnpm worker) so heavy,
 * untrusted-input processing (FFmpeg, libvips) is isolated and scales on queue depth.
 */
import { closePools } from "../server/db/client";
import { env } from "../server/env";
import { errorMessage, log, runOnce, workerId } from "../server/jobs/runner";
import { sweepExpiredUploads } from "../server/modules/uploads";

let stopping = false;
const IDLE_MS = 1500;
const SWEEP_MS = 10 * 60 * 1000;

async function loop(slot: number) {
  while (!stopping) {
    try {
      const worked = await runOnce();
      if (!worked) await sleep(IDLE_MS);
    } catch (err) {
      log("error", "worker loop error", { slot, error: errorMessage(err) });
      await sleep(5000);
    }
  }
}

async function sweeper() {
  while (!stopping) {
    try {
      const n = await sweepExpiredUploads();
      if (n) log("info", "aborted expired uploads", { count: n });
    } catch (err) {
      log("error", "upload sweep failed", { error: errorMessage(err) });
    }
    // Sleep in short steps so shutdown isn't delayed by the sweep interval.
    for (let waited = 0; waited < SWEEP_MS && !stopping; waited += 1000) await sleep(1000);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const concurrency = env().WORKER_CONCURRENCY;
  log("info", "worker started", { concurrency, id: workerId });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down after current jobs");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await Promise.all([...Array.from({ length: concurrency }, (_, i) => loop(i)), sweeper()]);
  await closePools();
  process.exit(0);
}

main().catch((err) => {
  log("error", "worker crashed", { error: (err as Error).stack });
  process.exit(1);
});
