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
 *
 * `"default"` needs special handling here: it's the generic placeholder root-symbol name
 * this tool assigns to *every* `export default ...` (see `apidiff.ts`'s `collectExports`,
 * commit `5d2a88a`) -- unlike every other root symbol, which is a real exported identifier
 * from the package's own source, `"default"` is also just an everyday English word that
 * shows up in plenty of unrelated commit messages ("change default timeout", "default
 * export flag", etc.). A bare substring match on it defeats the whole point of this
 * per-symbol check (commit `1b21879`, shipped the same day): confirmed via a synthetic
 * repro that an unrelated `feat!: change default timeout from 30s to 10s` commit silently
 * masked a real, separately-committed, mislabeled `fix:` that added a required parameter to
 * the package's actual default-exported class -- the exact masking bug `1b21879` exists to
 * prevent, reopened by the very next commit that added default-export support. Requiring the
 * more specific two-word phrase "default export" instead still lets a commit that's
 * genuinely declaring a break on the default export count (e.g. "fix!: default export now
 * requires an apiKey"), while no longer firing on ordinary, unrelated uses of the word.
 */
function commitMentionsSymbol(commit: ParsedCommit, symbolRoot: string): boolean {
  if (!symbolRoot) return false;
  const haystack = `${commit.subject}\n${commit.body}`.toLowerCase();
  if (symbolRoot.toLowerCase() === "default") {
    return haystack.includes("default export");
  }
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
