import type { CommitType, GroupedCommits, ParsedCommit } from "./types.js";
import type { RawCommit } from "./git.js";

const KNOWN_TYPES: CommitType[] = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "chore",
  "build",
  "ci",
  "style",
  "revert",
];

// e.g. "feat(sdk)!: add campaigns support (#352)"
const SUBJECT_RE = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;
// matches a trailing "(#123)" PR reference, as left by GitHub squash-merge
const PR_SUFFIX_RE = /\(#(\d+)\)\s*$/;
const BREAKING_FOOTER_RE = /BREAKING[ -]CHANGE:\s*(.+)/i;

export function parseCommit(raw: RawCommit): ParsedCommit {
  const subjectMatch = SUBJECT_RE.exec(raw.subject.trim());
  const prMatch = PR_SUFFIX_RE.exec(raw.subject) ?? PR_SUFFIX_RE.exec(raw.body);
  const breakingFooter = BREAKING_FOOTER_RE.exec(raw.body);

  let type: CommitType = "other";
  let scope: string | null = null;
  let bang = false;
  let description = raw.subject.trim();

  if (subjectMatch) {
    const rawType = subjectMatch[1]?.toLowerCase() ?? "";
    if (KNOWN_TYPES.includes(rawType as CommitType)) {
      type = rawType as CommitType;
    }
    scope = subjectMatch[3] ?? null;
    bang = subjectMatch[4] === "!";
    description = subjectMatch[5] ?? description;
  }

  // strip a trailing PR reference from the human-readable description
  description = description.replace(PR_SUFFIX_RE, "").trim();

  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    subject: raw.subject,
    body: raw.body,
    type,
    scope,
    description,
    declaredBreaking: bang || Boolean(breakingFooter),
    breakingNote: breakingFooter ? breakingFooter[1].trim() : null,
    prNumber: prMatch ? Number(prMatch[1]) : null,
  };
}

export function parseCommits(raws: RawCommit[]): ParsedCommit[] {
  return raws.map(parseCommit);
}

export function groupCommits(commits: ParsedCommit[]): GroupedCommits {
  const groups: GroupedCommits = {
    breakingDeclared: [],
    feat: [],
    fix: [],
    changed: [],
    docs: [],
    other: [],
  };

  for (const c of commits) {
    if (c.declaredBreaking) groups.breakingDeclared.push(c);
    if (c.type === "feat") groups.feat.push(c);
    else if (c.type === "fix") groups.fix.push(c);
    else if (c.type === "refactor" || c.type === "perf") groups.changed.push(c);
    else if (c.type === "docs") groups.docs.push(c);
    else if (c.type === "chore" || c.type === "build" || c.type === "ci" || c.type === "style" || c.type === "test") {
      // maintenance noise — intentionally left out of the user-facing notes
    } else {
      groups.other.push(c);
    }
  }

  return groups;
}
