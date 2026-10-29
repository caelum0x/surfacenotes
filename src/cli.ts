#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { collectCommits, materializeSnapshot, resolveRef } from "./git.js";
import { parseCommits, groupCommits } from "./commits.js";
import { diffApiSurfaces } from "./apidiff.js";
import { verify } from "./verify.js";
import { renderChangelog, renderReleaseNotes, mergeChangelogFile } from "./changelog.js";
import { generateNarrative, resolveAiConfig } from "./ai.js";
import { runWatch } from "./watch.js";

interface Args {
  repo: string;
  entry: string;
  from: string;
  to: string;
  version: string;
  outDir: string;
  repoUrl?: string;
  keepTemp: boolean;
  ai: boolean;
}

interface WatchArgs {
  repo: string;
  entry: string;
  from: string;
  debounceMs: number;
}

/** Shared `--flag value` / `--flag` (boolean-ish) parser used by every subcommand. */
function parseFlags(argv: string[]): Record<string, string> {
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
  return args;
}

function parseArgs(argv: string[]): Args {
  const args = parseFlags(argv);

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
    ai: args.ai === "true",
  };
}

function parseWatchArgs(argv: string[]): WatchArgs {
  const args = parseFlags(argv);

  if (!args.repo || !args.entry || !args.from) {
    printUsage();
    process.exit(1);
  }

  return {
    repo: path.resolve(args.repo),
    entry: args.entry,
    from: args.from,
    debounceMs: args.debounce ? Number(args.debounce) : 300,
  };
}

function printUsage() {
  console.error(
    [
      "surfacenotes — verified changelog generator for TypeScript SDKs",
      "",
      "Usage:",
      "  surfacenotes generate --repo <path> --entry <relative-path-to-public-entry.ts> --from <ref> [--to <ref>] [options]",
      "  surfacenotes watch --repo <path> --entry <relative-path-to-public-entry.ts> --from <ref> [--debounce <ms>]",
      "",
      "generate — diff two git refs/tags, write CHANGELOG.md + RELEASE_NOTES.md",
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
      "  --ai              Add an AI-written narrative summary, fed only the already-grouped",
      "                    commit bullets (never raw diffs). Off by default, never required.",
      "                    Configure via env: SURFACENOTES_AI_BASE_URL + SURFACENOTES_AI_API_KEY",
      "                    (any OpenAI-compatible endpoint), or SURFACENOTES_AI_BASE_URL=ollama",
      "                    for a local model, or just OPENAI_API_KEY for plain OpenAI. Missing",
      "                    config is not an error: --ai silently falls back to the structured-only",
      "                    output.",
      "",
      "watch — local dev loop: diff a baseline ref against the live working tree",
      "        (uncommitted edits included), re-checking every time a source file",
      "        changes, so a breaking API edit is caught the moment it's saved —",
      "        before it's ever committed or tagged. No files are written; the",
      "        report prints straight to the terminal. Stop with Ctrl+C.",
      "",
      "Required:",
      "  --repo <path>     Path to the git repository (read-only; never modified)",
      "  --entry <path>    Repo-relative path to the package's public entry file",
      "  --from <ref>      Baseline git ref/tag to diff the working tree against",
      "",
      "Options:",
      "  --debounce <ms>   Wait this long after the last change before re-diffing (default: 300)",
    ].join("\n"),
  );
}

async function main() {
  const command = process.argv[2];

  if (command === "watch") {
    const watchArgs = parseWatchArgs(process.argv.slice(3));
    await runWatch(watchArgs);
    return;
  }

  if (command !== "generate") {
    printUsage();
    process.exit(command === undefined ? 1 : 0);
  }

  const args = parseArgs(process.argv.slice(2));

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

  let narrative: string | null = null;
  if (args.ai) {
    const aiConfig = resolveAiConfig();
    if (!aiConfig) {
      console.error(
        "[surfacenotes] --ai was passed but no AI endpoint is configured (set SURFACENOTES_AI_BASE_URL + " +
          "SURFACENOTES_AI_API_KEY, SURFACENOTES_AI_BASE_URL=ollama for a local model, or OPENAI_API_KEY) " +
          "— continuing with the structured-only output.",
      );
    } else {
      console.error(`[surfacenotes] requesting AI narrative summary from ${aiConfig.baseUrl} (model ${aiConfig.model})`);
      narrative = await generateNarrative(groups, aiConfig);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const changelog = renderChangelog({
    version: args.version,
    date,
    groups,
    verification,
    apiDiff,
    repoUrl: args.repoUrl,
    narrative: narrative ?? undefined,
  });
  const releaseNotes = renderReleaseNotes({
    version: args.version,
    date,
    groups,
    verification,
    apiDiff,
    narrative: narrative ?? undefined,
  });

  mkdirSync(args.outDir, { recursive: true });
  const changelogPath = path.join(args.outDir, "CHANGELOG.md");
  const releaseNotesPath = path.join(args.outDir, "RELEASE_NOTES.md");
  const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null;
  const existingReleaseNotes = existsSync(releaseNotesPath) ? readFileSync(releaseNotesPath, "utf8") : null;
  writeFileSync(changelogPath, mergeChangelogFile(existingChangelog, changelog, args.version), "utf8");
  writeFileSync(releaseNotesPath, mergeChangelogFile(existingReleaseNotes, releaseNotes, args.version), "utf8");
  console.error(`[surfacenotes] wrote CHANGELOG.md and RELEASE_NOTES.md to ${args.outDir} (preserving prior release history)`);

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
