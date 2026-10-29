import type { ApiDiffResult, GroupedCommits, ParsedCommit, VerificationResult } from "./types.js";

function commitLine(c: ParsedCommit, repoUrl?: string): string {
  const scope = c.scope ? `**${c.scope}:** ` : "";
  const ref = c.prNumber
    ? repoUrl
      ? `[#${c.prNumber}](${repoUrl}/pull/${c.prNumber})`
      : `#${c.prNumber}`
    : `\`${c.shortSha}\``;
  return `- ${scope}${c.description} (${ref})`;
}

function section(title: string, commits: ParsedCommit[], repoUrl?: string): string {
  if (commits.length === 0) return "";
  return `### ${title}\n\n${commits.map((c) => commitLine(c, repoUrl)).join("\n")}\n`;
}

function verificationBanner(verification: VerificationResult, apiDiff: ApiDiffResult): string {
  if (!verification.undeclaredBreakingChange) {
    return (
      `> **API verified:** no breaking changes were found in the public API surface ` +
      `(\`${apiDiff.entryFile}\`) that weren't already declared in the commits above.\n`
    );
  }

  const details = verification.mismatchDetails.map((c) => `  - ${c.detail}`).join("\n");
  return (
    `> ⚠️ **VERIFIED BREAKING CHANGE — not declared in any commit message.**\n` +
    `> A structural diff of the public API surface (\`${apiDiff.entryFile}\`) between ` +
    `\`${apiDiff.fromRef}\` and \`${apiDiff.toRef}\` found breaking changes that no commit ` +
    `marked with \`!\` or a \`BREAKING CHANGE:\` footer:\n${details}\n` +
    `> Double-check the version bump for this release before publishing.\n`
  );
}

/**
 * Labeled explicitly as AI-generated and explicitly scoped to "the commits above" — never
 * presented as part of the verified structural-diff result, since that verification (see
 * verificationBanner) is the one claim in this tool's output that must never be touched by a
 * model that can hallucinate.
 */
function narrativeSection(narrative: string | undefined): string {
  if (!narrative) return "";
  return `_AI-generated summary of the commits above (not used for the verified check):_\n${narrative}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Merge a freshly-rendered release entry into whatever `CHANGELOG.md` /
 * `RELEASE_NOTES.md` already exists on disk, instead of overwriting the
 * whole file. Surfacenotes is meant to be run on every release of a real
 * package, same as `git-cliff`/`release-please`/`conventional-changelog` —
 * but unlike those tools, plain `writeFileSync` here silently destroyed
 * every previously-recorded release's entry on the very next run (confirmed
 * live: running `generate` for `v1.6.0..v1.6.1` then `v1.6.1..v1.6.2` into
 * the same `--out-dir` left `CHANGELOG.md` containing only the v1.6.2
 * section, with the v1.6.1 release — including its own verification
 * banner — gone without a trace). A heading for `version` (`## <version> —
 * <date>`) is searched for by `version` alone, not the full heading text
 * with date, so re-running `generate` for the same version on a different
 * day replaces that version's section in place (idempotent) rather than
 * duplicating it; any other existing version keeps its original section
 * untouched, and the new entry is prepended above it to preserve the
 * reverse-chronological order every changelog convention expects.
 */
export function mergeChangelogFile(existing: string | null, newEntry: string, version: string): string {
  const trimmedEntry = newEntry.trimEnd() + "\n";
  if (!existing || !existing.trim()) return trimmedEntry;

  const headingRe = new RegExp(`^## ${escapeRegExp(version)}\\b.*$`, "m");
  const headingMatch = headingRe.exec(existing);
  if (!headingMatch) return trimmedEntry + "\n" + existing.trimStart();

  const sectionStart = headingMatch.index;
  const nextHeadingRe = /^## /m;
  const afterHeading = existing.slice(sectionStart + headingMatch[0].length);
  const nextMatch = nextHeadingRe.exec(afterHeading);
  const sectionEnd = nextMatch ? sectionStart + headingMatch[0].length + nextMatch.index : existing.length;

  const before = existing.slice(0, sectionStart).trimEnd();
  const after = existing.slice(sectionEnd).trimStart();
  return [before, trimmedEntry, after].filter((part) => part.length > 0).join("\n\n").trimEnd() + "\n";
}

export function renderChangelog(opts: {
  version: string;
  date: string;
  groups: GroupedCommits;
  verification: VerificationResult;
  apiDiff: ApiDiffResult;
  repoUrl?: string;
  narrative?: string;
}): string {
  const { groups, verification, apiDiff, repoUrl, narrative } = opts;
  const parts = [
    `## ${opts.version} — ${opts.date}`,
    "",
    narrativeSection(narrative),
    verificationBanner(verification, apiDiff),
    section("Breaking changes", groups.breakingDeclared, repoUrl),
    section("Added", groups.feat, repoUrl),
    section("Fixed", groups.fix, repoUrl),
    section("Changed", groups.changed, repoUrl),
    section("Docs", groups.docs, repoUrl),
    section("Other", groups.other, repoUrl),
  ].filter(Boolean);

  return parts.join("\n").trimEnd() + "\n";
}

/** Same data, phrased for end users rather than contributors: no commit hashes/prefixes. */
export function renderReleaseNotes(opts: {
  version: string;
  date: string;
  groups: GroupedCommits;
  verification: VerificationResult;
  apiDiff: ApiDiffResult;
  narrative?: string;
}): string {
  const { groups, verification, apiDiff, narrative } = opts;
  const userLine = (c: ParsedCommit) => `- ${c.description}`;
  const userSection = (title: string, commits: ParsedCommit[]) =>
    commits.length === 0 ? "" : `### ${title}\n\n${commits.map(userLine).join("\n")}\n`;

  const parts = [
    `## ${opts.version} — ${opts.date}`,
    "",
    narrativeSection(narrative),
    verificationBanner(verification, apiDiff),
    userSection("What's new", groups.feat),
    userSection("Fixes", groups.fix),
    userSection("Improvements", groups.changed),
  ].filter(Boolean);

  return parts.join("\n").trimEnd() + "\n";
}
