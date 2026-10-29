// Shared types for surfacenotes.

export type CommitType =
  | "feat"
  | "fix"
  | "refactor"
  | "perf"
  | "docs"
  | "test"
  | "chore"
  | "build"
  | "ci"
  | "style"
  | "revert"
  | "other";

export interface ParsedCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  type: CommitType;
  scope: string | null;
  description: string;
  /** true if the subject used `type!:` or the body has a `BREAKING CHANGE:` footer */
  declaredBreaking: boolean;
  breakingNote: string | null;
  prNumber: number | null;
}

export type ApiChangeKind =
  | "export-removed"
  | "export-added"
  | "member-removed"
  | "member-added"
  | "signature-narrowed"
  | "signature-widened"
  | "required-field-added"
  | "field-removed"
  | "param-removed"
  | "enum-value-changed";

export type ApiChangeSeverity = "breaking" | "safe";

export interface ApiChange {
  kind: ApiChangeKind;
  severity: ApiChangeSeverity;
  /** dotted path, e.g. "UseSend.campaigns" or "sendEmail(params)" */
  symbol: string;
  detail: string;
}

export interface ApiDiffResult {
  entryFile: string;
  fromRef: string;
  toRef: string;
  changes: ApiChange[];
  /** symbols that failed to resolve a type (best-effort analysis, not a hard failure) */
  unresolvedWarnings: string[];
}

export interface GroupedCommits {
  breakingDeclared: ParsedCommit[];
  feat: ParsedCommit[];
  fix: ParsedCommit[];
  changed: ParsedCommit[]; // refactor + perf
  docs: ParsedCommit[];
  other: ParsedCommit[];
}

export interface VerificationResult {
  /** highest severity actually present in the real API diff */
  actualSeverity: ApiChangeSeverity;
  /** highest severity the commit messages themselves claimed */
  claimedSeverity: ApiChangeSeverity;
  /** true when the API diff found a breaking change no commit declared */
  undeclaredBreakingChange: boolean;
  mismatchDetails: ApiChange[];
}
