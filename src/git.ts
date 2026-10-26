import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

export interface RawCommit {
  sha: string;
  subject: string;
  body: string;
}

/** Run `git` read-only inside `repo`. Never mutates the target repo. */
function git(repo: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
  });
}

/** List commits in `from..to` (exclusive of `from`, inclusive of `to`), oldest first. */
export function collectCommits(repo: string, from: string, to: string): RawCommit[] {
  const sep = "\x1f"; // unit separator, unlikely to appear in commit text
  const end = "\x1e"; // record separator
  const format = `%H${sep}%s${sep}%b${end}`;
  const out = git(repo, ["log", "--date-order", `--pretty=format:${format}`, `${from}..${to}`]);
  if (!out.trim()) return [];
  return out
    .split(end)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, body] = rec.split(sep);
      return { sha: sha ?? "", subject: subject ?? "", body: (body ?? "").trim() };
    })
    // git log prints newest first; reverse to oldest-first for a natural changelog read order
    .reverse();
}

export function resolveRef(repo: string, ref: string): string {
  return git(repo, ["rev-parse", ref]).trim();
}

export function shortSha(repo: string, sha: string): string {
  return git(repo, ["rev-parse", "--short", sha]).trim();
}

/**
 * Does a real *file* (git blob) exist at `path` at `ref`? `cat-file -e`
 * alone isn't enough: it also succeeds for directories, which are git tree
 * objects with their own valid object id -- and `git show ref:some/dir`
 * doesn't fail either, it returns a plain-text directory listing. Without
 * the explicit blob check, a bare import specifier like `from "./foo"` that
 * resolves to a real directory `foo/` (with its own `foo/index.ts` inside)
 * gets misread as a resolved file, and that directory's listing text gets
 * written to disk at the same path the real `foo/` subdirectory needs to
 * occupy for its actual files -- crashing materializeSnapshot with EEXIST.
 */
function existsAtRef(repo: string, ref: string, filePath: string): boolean {
  try {
    const type = git(repo, ["cat-file", "-t", `${ref}:${filePath}`], { quiet: true }).trim();
    return type === "blob";
  } catch {
    return false;
  }
}

function readAtRef(repo: string, ref: string, filePath: string): string | null {
  try {
    return git(repo, ["show", `${ref}:${filePath}`], { quiet: true });
  } catch {
    return null;
  }
}

const RESOLVE_CANDIDATES = (p: string) => [
  p,
  `${p}.ts`,
  `${p}.tsx`,
  `${p}/index.ts`,
  `${p}/index.tsx`,
];

/**
 * Resolve a relative import specifier (e.g. "./src/usesend") against the
 * importing file's directory to a repo-relative file path that actually
 * exists at `ref`. Returns null for bare/package specifiers (we do not
 * follow into node_modules — only the package's own source matters for its
 * public API surface).
 */
function resolveImport(
  repo: string,
  ref: string,
  importerRepoPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null; // bare import, e.g. "node:fs" or a dependency
  const importerDir = path.posix.dirname(importerRepoPath);
  const joined = path.posix.normalize(path.posix.join(importerDir, specifier));
  for (const candidate of RESOLVE_CANDIDATES(joined)) {
    if (existsAtRef(repo, ref, candidate)) return candidate;
  }
  return null;
}

function extractImportSpecifiers(source: string, filePath: string): string[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

export interface MaterializedSnapshot {
  /** absolute path to the temp directory root */
  dir: string;
  /** absolute path to the entry file inside `dir` */
  entryFile: string;
  /** repo-relative paths that were pulled in */
  files: string[];
  unresolved: string[];
}

/**
 * Walk the transitive closure of local (relative-path) imports starting at
 * `entryRepoPath`, as they existed at `ref`, and write them into a fresh
 * temp directory with the same relative layout so the TypeScript compiler
 * can resolve local imports normally. Only reads from git (via `git show` /
 * `git cat-file`) — never touches the working tree or checks anything out.
 */
export function materializeSnapshot(
  repo: string,
  ref: string,
  entryRepoPath: string,
): MaterializedSnapshot {
  const dir = mkdtempSync(path.join(tmpdir(), "surfacenotes-"));
  const seen = new Map<string, string>();
  const unresolved: string[] = [];
  const queue: string[] = [entryRepoPath];

  while (queue.length > 0) {
    const repoPath = queue.shift()!;
    if (seen.has(repoPath)) continue;
    const content = readAtRef(repo, ref, repoPath);
    if (content === null) {
      unresolved.push(repoPath);
      continue;
    }
    seen.set(repoPath, content);
    for (const spec of extractImportSpecifiers(content, repoPath)) {
      const resolved = resolveImport(repo, ref, repoPath, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  for (const [repoPath, content] of seen) {
    const dest = path.join(dir, repoPath);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
  }

  return {
    dir,
    entryFile: path.join(dir, entryRepoPath),
    files: [...seen.keys()],
    unresolved,
  };
}
