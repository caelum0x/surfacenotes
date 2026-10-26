import type { ApiChange, GroupedCommits, VerificationResult } from "./types.js";

/**
 * Compare what the real API diff found against what the commit messages in
 * the same range claimed, so the generated changelog never has to take a
 * conventional-commit label on faith.
 */
export function verify(changes: ApiChange[], groups: GroupedCommits): VerificationResult {
  const actualBreaking = changes.filter((c) => c.severity === "breaking");
  const actualSeverity = actualBreaking.length > 0 ? "breaking" : "safe";
  const claimedSeverity = groups.breakingDeclared.length > 0 ? "breaking" : "safe";

  return {
    actualSeverity,
    claimedSeverity,
    undeclaredBreakingChange: actualSeverity === "breaking" && claimedSeverity === "safe",
    mismatchDetails: actualBreaking,
  };
}
