import { spawn } from "node:child_process";

export class ProcessError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

/**
 * Runs a binary with an argument array (never a shell string), a timeout and
 * an abort signal. Collects stdout as a Buffer.
 */
export function run(cmd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; maxStdout?: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    const max = opts.maxStdout ?? 64 * 1024 * 1024;
    const kill = (reason: string) => {
      child.kill("SIGKILL");
      reject(new ProcessError(reason, err));
    };
    const timer = setTimeout(() => kill(`${cmd} timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
    const onAbort = () => kill(`${cmd} aborted`);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > max) kill(`${cmd} produced too much output`);
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 16_384) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProcessError(`${cmd} failed to start: ${e.message}`, err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new ProcessError(`${cmd} exited with code ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`, err));
    });
  });
}
