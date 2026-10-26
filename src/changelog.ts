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

export function renderChangelog(opts: {
  version: string;
  date: string;
  groups: GroupedCommits;
  verification: VerificationResult;
  apiDiff: ApiDiffResult;
  repoUrl?: string;
}): string {
  const { groups, verification, apiDiff, repoUrl } = opts;
  const parts = [
    `## ${opts.version} — ${opts.date}`,
    "",
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
}): string {
  const { groups, verification, apiDiff } = opts;
  const userLine = (c: ParsedCommit) => `- ${c.description}`;
  const userSection = (title: string, commits: ParsedCommit[]) =>
    commits.length === 0 ? "" : `### ${title}\n\n${commits.map(userLine).join("\n")}\n`;

  const parts = [
    `## ${opts.version} — ${opts.date}`,
    "",
    verificationBanner(verification, apiDiff),
    userSection("What's new", groups.feat),
    userSection("Fixes", groups.fix),
    userSection("Improvements", groups.changed),
  ].filter(Boolean);

  return parts.join("\n").trimEnd() + "\n";
}
