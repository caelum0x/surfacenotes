import type { ApiChange, GroupedCommits, ParsedCommit, VerificationResult } from "./types.js";

/** The exported symbol a change happened on, e.g. "SendOptions" from "SendOptions.idempotencyKey". */
function rootSymbol(symbol: string): string {
  return symbol.split(".")[0];
}

/**
 * Best-effort check that a commit's own text actually names the symbol that broke, so a
 * release with *some* declared-breaking commit can't blanket-cover an unrelated real break
 * hiding in a different, mislabeled commit in the same range (see commitMentionsSymbol
 * callers below for why this matters).
 */
function commitMentionsSymbol(commit: ParsedCommit, symbolRoot: string): boolean {
  if (!symbolRoot) return false;
  const haystack = `${commit.subject}\n${commit.body}`.toLowerCase();
  return haystack.includes(symbolRoot.toLowerCase());
}

/**
 * Compare what the real API diff found against what the commit messages in
 * the same range claimed, so the generated changelog never has to take a
 * conventional-commit label on faith.
 *
 * This is per-change, not per-release: a range with 5 commits where only one
 * (unrelated) commit is marked `!`/`BREAKING CHANGE:` must not let that one
 * declaration silently cover a *different* real breaking change found by the
 * structural diff on some other symbol, fixed as a mislabeled `fix:` with no
 * footer. Each breaking `ApiChange` is checked against the declared-breaking
 * commits individually (by whether its root export name is actually named in
 * one of them) rather than against a single release-wide "was anything in
 * this range declared breaking?" flag — the earlier version of this check
 * used that release-wide flag and could mask exactly this case.
 */
export function verify(changes: ApiChange[], groups: GroupedCommits): VerificationResult {
  const actualBreaking = changes.filter((c) => c.severity === "breaking");
  const actualSeverity = actualBreaking.length > 0 ? "breaking" : "safe";
  const claimedSeverity = groups.breakingDeclared.length > 0 ? "breaking" : "safe";

  const undeclared = actualBreaking.filter(
    (change) =>
      !groups.breakingDeclared.some((commit) => commitMentionsSymbol(commit, rootSymbol(change.symbol))),
  );

  return {
    actualSeverity,
    claimedSeverity,
    undeclaredBreakingChange: undeclared.length > 0,
    mismatchDetails: undeclared,
  };
}
