# Surfacenotes

Changelog and release-notes generator for TypeScript library and SDK
maintainers. Surfacenotes writes the same `CHANGELOG.md` /
`RELEASE_NOTES.md` pair most changelog tools write — but it never trusts a
`feat:`/`fix:` commit label to tell you whether a release is actually
breaking. It parses the package's public entry file with the real
TypeScript compiler at both git refs, structurally diffs the exported
surface (removed exports, removed class members, new required parameters,
optional-to-required field changes), and cross-checks that against what the
commits in the same range declared. If the two disagree, the generated
changelog gets a loud warning banner instead of a confident lie.

## Why this exists

Conventional-commit-based changelog tools (`git-cliff`, `release-please`,
`conventional-changelog`, and the newer AI wrappers like `shipnote`,
`ChangelogAI`, ShipTell, Engammo, `ai-changelog-generator`) all take the
author's `feat:`/`fix:`/`BREAKING CHANGE:` label on faith. That label is
written by a human in a hurry, and it is wrong more often than teams like to
admit — e.g. a "small refactor" that quietly drops a required export gets
tagged `fix:` and shipped as a patch. Separately, a handful of tools
(`@clerk/break-check`, `semver-checks`, `semver-guard`) already verify a
package's real TypeScript API surface for exactly this reason — but they
are CI gates that recommend a semver bump, not changelog generators, so
nobody sees a human-readable explanation of what broke.

Surfacenotes is the combination: a real changelog/release-notes generator
whose breaking-change section is backed by a real structural diff of your
code, not a trust exercise. Source research for this gap (AI "fluff" and
hallucination complaints on AI changelog tools, squash-merge handling
details, the `p-limit` 6.1.0 example of a breaking type change shipped as a
minor) is summarized in `~/products/plans/surfacenotes.md`.

## What it does today (MVP)

- Reads commits in a `from..to` git range (works with squash-merged PRs:
  `(#123)` suffixes and `gh`-style merge subjects are recognized).
- Groups them the conventional-commit way: Breaking / Added / Fixed /
  Changed / Docs / Other. Commits without a recognizable `type:` prefix
  still show up under "Other" instead of being silently dropped.
- Pulls the package's public entry file (and everything it locally
  re-exports) at both refs straight out of git (`git show`/`git cat-file`,
  read-only, no checkout, no worktree) and parses both snapshots with the
  real `typescript` compiler package.
- Structurally diffs the two snapshots: removed exports/members are
  breaking, new required parameters are breaking, an optional-to-required
  field on an `interface`/`type` is breaking, everything additive is safe.
- Writes `CHANGELOG.md` (developer-facing, with commit/PR links) and
  `RELEASE_NOTES.md` (same data, plain language, no hashes) with a
  verification banner at the top of each release. Exits with status `2`
  when it finds an undeclared breaking change, so it can gate a CI release
  job.

## What it intentionally does not do yet

- No AI narrative rewrite pass is wired up in this MVP. The structured,
  already-deduplicated commit bullets are the right shape to *safely* feed
  an AI rewrite later (constrained input avoids the "hallucination wearing
  a changelog costume" failure mode found in research), but no hosted or
  local model call ships in `v0.1.0` — nothing here should send your
  commits to a third party. Hook it up in `src/changelog.ts` behind an
  explicit `--ai` flag that points at a local/your-own endpoint when ready.
- The structural diff is a heuristic, not a full type-compatibility
  checker. It catches the common, high-value cases (removed exports,
  removed members, new required parameters, optional→required field
  flips) and intentionally reports ambiguous type-text changes as
  informational rather than guessing.
- Only local (relative-path) imports are followed. Changes inside a
  dependency you re-export are out of scope for v0.1.0.

## Usage

```bash
npm install -g surfacenotes   # or: npx surfacenotes ...

surfacenotes generate \
  --repo /path/to/your/repo \
  --entry packages/sdk/index.ts \
  --from v1.6.0 --to v1.7.2 \
  --repo-url https://github.com/you/your-repo \
  --out-dir .
```

This writes `CHANGELOG.md` and `RELEASE_NOTES.md` into `--out-dir`. Run it
as a release-pipeline step right before `npm publish`; a non-zero exit
means an undeclared breaking change was found in the diff and the release
is worth a second look before it ships. (That's a feature to run inside
*your* CI — this repository itself has no CI/CD workflows by design.)

## Using it programmatically

```ts
import { collectCommits, diffApiSurfaces, verify } from "surfacenotes";
```

See `src/index.ts` for the full list of exported building blocks.

## License

MIT. See `LICENSE`. No code was forked from another project — this is a
fresh implementation written directly against the `typescript` compiler
package and Node's `child_process`/`fs`, after evaluating `git-cliff`,
`conventional-changelog`, `release-please`, `mogesjohnson/release-notes`,
`shipnote`, `entro314-labs/ai-changelog-generator`, `@clerk/break-check`,
and `semver-checks` as prior art (see the plan file for why none of them
cover this combination).

## Verifying it yourself

```bash
npm install
npm run build
node dist/cli.js generate --repo <any git repo> --entry <path to its public entry file> --from <tag> --to <tag-or-HEAD>
```
