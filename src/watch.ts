import fs from "node:fs";
import path from "node:path";
import { materializeSnapshot, resolveRef } from "./git.js";
import { diffApiSurfaces } from "./apidiff.js";
import type { ApiDiffResult } from "./types.js";

export interface WatchOptions {
  repo: string;
  entry: string;
  from: string;
  /** milliseconds to wait after the last detected change before re-diffing */
  debounceMs: number;
}

const IGNORED_DIR_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".surfacenotes"]);
const SOURCE_FILE_RE = /\.(ts|tsx)$/;

/**
 * Cheap recursive directory signature: every real ts/tsx file's repo-relative
 * path plus its mtime, joined into one string. Two snapshots of an unchanged
 * tree produce an identical string; any edit, add, rename, or delete changes
 * it. Used as the portable fallback change detector (see `watchForChanges`)
 * since `fs.watch(dir, { recursive: true })` is not supported on every
 * platform/Node version (notably Linux inotify), and this CLI has to work
 * the same way everywhere it's installed.
 */
function directorySignature(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_SEGMENTS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) {
        const stat = fs.statSync(abs);
        parts.push(`${path.relative(root, abs)}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return parts.sort().join("\n");
}

function renderWatchReport(diff: ApiDiffResult): string {
  const breaking = diff.changes.filter((c) => c.severity === "breaking");
  const safe = diff.changes.filter((c) => c.severity === "safe");
  const stamp = new Date().toLocaleTimeString();
  const lines: string[] = [
    "",
    `[surfacenotes watch] ${stamp} — ${diff.fromRef} -> working tree (${diff.entryFile})`,
  ];

  if (diff.changes.length === 0) {
    lines.push("  no structural API changes detected since the baseline.");
  } else {
    if (breaking.length > 0) {
      lines.push(`  ⚠  ${breaking.length} BREAKING change(s):`);
      for (const c of breaking) lines.push(`    - [${c.kind}] ${c.symbol}: ${c.detail}`);
    }
    if (safe.length > 0) {
      lines.push(`  ${safe.length} additive/safe change(s):`);
      for (const c of safe) lines.push(`    - [${c.kind}] ${c.symbol}: ${c.detail}`);
    }
  }

  if (diff.unresolvedWarnings.length > 0) {
    lines.push(
      `  note: ${diff.unresolvedWarnings.length} exported symbol(s) could not be resolved for structural diffing.`,
    );
  }

  return lines.join("\n");
}

/**
 * Diff the baseline ref against the *live working tree* (uncommitted edits
 * included) — not two git refs. `materializeSnapshot` still supplies the
 * read-only baseline side via `git show`, exactly as `generate` does, but
 * the "to" side points straight at the real files on disk so every save
 * is reflected immediately, including changes that were never staged.
 */
function diffAgainstWorkingTree(opts: WatchOptions, fromSha: string): ApiDiffResult {
  const fromSnapshot = materializeSnapshot(opts.repo, fromSha, opts.entry);
  try {
    return diffApiSurfaces({
      fromDir: fromSnapshot.dir,
      fromEntry: fromSnapshot.entryFile,
      toDir: opts.repo,
      toEntry: path.join(opts.repo, opts.entry),
      fromRef: opts.from,
      toRef: "working tree",
    });
  } finally {
    fs.rmSync(fromSnapshot.dir, { recursive: true, force: true });
  }
}

/**
 * Watch `root` for real source-file changes and invoke `onChange` (debounced)
 * each time something settles. Prefers native `fs.watch(..., { recursive })`
 * where the platform/Node version supports it (fast, event-driven); falls
 * back to lightweight signature polling everywhere else so the feature never
 * just silently does nothing on an unsupported platform.
 */
function watchForChanges(root: string, debounceMs: number, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const scheduled = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || !SOURCE_FILE_RE.test(filename)) return;
      if ([...IGNORED_DIR_SEGMENTS].some((seg) => filename.split(path.sep).includes(seg))) return;
      scheduled();
    });
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    // Recursive native watching isn't supported here (e.g. Linux inotify) —
    // fall back to polling a cheap directory signature.
    let lastSignature = directorySignature(root);
    const interval = setInterval(() => {
      const next = directorySignature(root);
      if (next !== lastSignature) {
        lastSignature = next;
        scheduled();
      }
    }, Math.max(300, Math.min(debounceMs, 1000)));
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
    };
  }
}

/**
 * `surfacenotes watch` — the local dev-loop companion to `generate`. Instead
 * of diffing two already-committed refs after the fact, it diffs a baseline
 * ref against whatever is on disk right now, live, so a maintainer sees the
 * moment an in-progress edit breaks the public API — before it's committed,
 * before it's tagged, before `generate` would ever get a chance to catch it.
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const fromSha = resolveRef(opts.repo, opts.from);

  console.error(
    `[surfacenotes watch] watching ${opts.repo} — baseline ${opts.from} (${fromSha.slice(0, 7)}), entry ${opts.entry}`,
  );
  console.error("[surfacenotes watch] press Ctrl+C to stop\n");

  const runOnce = () => {
    try {
      const diff = diffAgainstWorkingTree(opts, fromSha);
      console.error(renderWatchReport(diff));
    } catch (err) {
      console.error(
        `[surfacenotes watch] diff failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  runOnce();
  const stop = watchForChanges(opts.repo, opts.debounceMs, runOnce);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      stop();
      console.error("\n[surfacenotes watch] stopped.");
      resolve();
    });
  });
}
