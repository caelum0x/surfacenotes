import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Minimal cross-process advisory lock that serializes the read-merge-write sequence
 * `cli.ts` runs against `CHANGELOG.md`/`RELEASE_NOTES.md` in a given `--out-dir`.
 *
 * Real, reproducible bug this fixes: that sequence (`readFileSync` the existing file,
 * compute `mergeChangelogFile`, `writeFileSync` the result) is a classic
 * read-then-write race with no lock in between. Confirmed live with two concurrent
 * `generate` processes targeting the same `--out-dir`: whichever process's write
 * lands last silently clobbers the other's entire write, because both processes
 * read the SAME pre-existing file content before either one wrote — so the loser's
 * freshly-merged release section (including its own verification banner) vanishes
 * without a trace, byte-identical to the single-process bug `1c0350c` fixed earlier
 * the same day (destroying prior release history), just reopened by concurrency
 * instead of a bare overwrite. Two concurrent `generate` invocations against the
 * same `--out-dir` are a realistic real-world scenario for this tool's own stated
 * use case (running on every release, e.g. via CI, or backfilling several historical
 * tag ranges in parallel for speed — exactly what this project's own dogfooding
 * scans have done against `resend-node`).
 *
 * Implementation: an exclusive `open(path, "wx")` (fails with EEXIST if the lock
 * file already exists) on a sentinel file inside `outDir`, retried with a short
 * backoff until acquired or `timeoutMs` elapses. A lock file older than
 * `staleMs` is treated as abandoned (e.g. a crashed previous process) and removed
 * so a single crash can't deadlock every future `generate` run against that
 * `--out-dir` forever.
 */
const LOCK_FILE_NAME = ".surfacenotes.lock";

export interface ChangelogLockOptions {
  /** how long to keep retrying before giving up (ms) */
  timeoutMs?: number;
  /** delay between acquisition attempts (ms) */
  retryMs?: number;
  /** a lock file older than this is assumed abandoned by a crashed process and removed */
  staleMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeIfStale(lockPath: string, staleMs: number): void {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already gone (another process cleaned it up, or it never existed) — fine either way.
  }
}

async function acquireLock(lockPath: string, opts: Required<ChangelogLockOptions>): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      removeIfStale(lockPath, opts.staleMs);
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${opts.timeoutMs}ms waiting for the changelog lock at ${lockPath} — ` +
            `another "surfacenotes generate" run against the same --out-dir may still be in progress`,
        );
      }
      await sleep(opts.retryMs);
    }
  }
}

/**
 * Runs `fn` while holding an exclusive lock scoped to `outDir`, so two concurrent
 * `generate` invocations targeting the same `--out-dir` never interleave their
 * read-merge-write sequence. Always releases the lock, even if `fn` throws.
 */
export async function withChangelogLock<T>(
  outDir: string,
  fn: () => T,
  opts: ChangelogLockOptions = {},
): Promise<T> {
  const resolved: Required<ChangelogLockOptions> = {
    timeoutMs: opts.timeoutMs ?? 15_000,
    retryMs: opts.retryMs ?? 50,
    staleMs: opts.staleMs ?? 60_000,
  };
  const lockPath = path.join(outDir, LOCK_FILE_NAME);
  await acquireLock(lockPath, resolved);
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone — fine, nothing left to clean up.
    }
  }
}
