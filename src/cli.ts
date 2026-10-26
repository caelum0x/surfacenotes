#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { collectCommits, materializeSnapshot, resolveRef } from "./git.js";
import { parseCommits, groupCommits } from "./commits.js";
import { diffApiSurfaces } from "./apidiff.js";
import { verify } from "./verify.js";
import { renderChangelog, renderReleaseNotes } from "./changelog.js";

interface Args {
  repo: string;
  entry: string;
  from: string;
  to: string;
  version: string;
  outDir: string;
  repoUrl?: string;
  keepTemp: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }

  if (!args.repo || !args.entry || !args.from) {
    printUsage();
    process.exit(1);
  }

  return {
    repo: path.resolve(args.repo),
    entry: args.entry,
    from: args.from,
    to: args.to ?? "HEAD",
    version: args.version ?? args.to ?? "HEAD",
    outDir: path.resolve(args["out-dir"] ?? "."),
    repoUrl: args["repo-url"],
    keepTemp: args["keep-temp"] === "true",
  };
}

function printUsage() {
  console.error(
    [
      "surfacenotes generate — verified changelog generator for TypeScript SDKs",
      "",
      "Usage:",
      "  surfacenotes generate --repo <path> --entry <relative-path-to-public-entry.ts> --from <ref> [--to <ref>] [options]",
      "",
      "Required:",
      "  --repo <path>     Path to the git repository (read-only; never modified)",
      "  --entry <path>    Repo-relative path to the package's public entry file (e.g. src/index.ts)",
      "  --from <ref>      Git ref/tag to diff from",
      "",
      "Options:",
      "  --to <ref>        Git ref/tag to diff to (default: HEAD)",
      "  --version <name>  Label for the changelog heading (default: --to)",
      "  --out-dir <path>  Where to write CHANGELOG.md / RELEASE_NOTES.md (default: cwd)",
      "  --repo-url <url>  Base GitHub URL used to link PR numbers",
      "  --keep-temp       Keep the temporary API-surface snapshot directories for inspection",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = process.argv[2];
  if (command !== "generate") {
    printUsage();
    process.exit(command === undefined ? 1 : 0);
  }

  const fromSha = resolveRef(args.repo, args.from);
  const toSha = resolveRef(args.repo, args.to);

  console.error(`[surfacenotes] collecting commits ${args.from}..${args.to} in ${args.repo}`);
  const rawCommits = collectCommits(args.repo, fromSha, toSha);
  const commits = parseCommits(rawCommits);
  const groups = groupCommits(commits);
  console.error(`[surfacenotes] found ${commits.length} commits`);

  console.error(`[surfacenotes] materializing "${args.entry}" at ${args.from} and ${args.to} for API diffing`);
  const fromSnapshot = materializeSnapshot(args.repo, fromSha, args.entry);
  const toSnapshot = materializeSnapshot(args.repo, toSha, args.entry);
  console.error(
    `[surfacenotes] pulled ${fromSnapshot.files.length} file(s) at ${args.from}, ${toSnapshot.files.length} file(s) at ${args.to}`,
  );
  if (fromSnapshot.unresolved.length || toSnapshot.unresolved.length) {
    console.error(
      `[surfacenotes] note: ${fromSnapshot.unresolved.length + toSnapshot.unresolved.length} import(s) could not be resolved (likely external packages) and were skipped`,
    );
  }

  const apiDiff = diffApiSurfaces({
    fromDir: fromSnapshot.dir,
    fromEntry: fromSnapshot.entryFile,
    toDir: toSnapshot.dir,
    toEntry: toSnapshot.entryFile,
    fromRef: args.from,
    toRef: args.to,
  });
  console.error(`[surfacenotes] API diff found ${apiDiff.changes.length} structural change(s)`);
  if (apiDiff.unresolvedWarnings.length) {
    console.error(
      `[surfacenotes] note: ${apiDiff.unresolvedWarnings.length} exported symbol(s) could not be resolved for structural diffing`,
    );
  }

  const verification = verify(apiDiff.changes, groups);

  const date = new Date().toISOString().slice(0, 10);
  const changelog = renderChangelog({
    version: args.version,
    date,
    groups,
    verification,
    apiDiff,
    repoUrl: args.repoUrl,
  });
  const releaseNotes = renderReleaseNotes({ version: args.version, date, groups, verification, apiDiff });

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(path.join(args.outDir, "CHANGELOG.md"), changelog, "utf8");
  writeFileSync(path.join(args.outDir, "RELEASE_NOTES.md"), releaseNotes, "utf8");
  console.error(`[surfacenotes] wrote CHANGELOG.md and RELEASE_NOTES.md to ${args.outDir}`);

  if (verification.undeclaredBreakingChange) {
    console.error("[surfacenotes] ⚠️  undeclared breaking change detected — exiting with status 2");
  }

  if (!args.keepTemp) {
    rmSync(fromSnapshot.dir, { recursive: true, force: true });
    rmSync(toSnapshot.dir, { recursive: true, force: true });
  } else {
    console.error(`[surfacenotes] kept snapshots at ${fromSnapshot.dir} and ${toSnapshot.dir}`);
  }

  if (verification.undeclaredBreakingChange) process.exit(2);
}

main().catch((err) => {
  console.error("[surfacenotes] failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
