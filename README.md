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
  re-exports, including `export default` — both `export default class Foo
  {...}`/`export default function foo() {...}` declarations and the
  separate `class Foo {...}; export default Foo;` assignment form) at both
  refs straight out of git (`git show`/`git cat-file`, read-only, no
  checkout, no worktree) and parses both snapshots with the real
  `typescript` compiler package. Relative imports/re-exports that name a
  compiled `.js`/`.jsx`/`.mjs`/`.cjs` extension (the real `"moduleResolution":
  "nodenext"`/`"node16"` ESM convention, e.g. `export { X } from
  "./foo.js"` resolving to a real `foo.ts` — confirmed live against the real
  `@octokit/core` source) resolve to their real TS source file instead of
  silently failing to resolve at all.
- Structurally diffs the two snapshots: removed exports/members (including
  `get`/`set` class accessors, not just methods and plain properties) are
  breaking, new required parameters (or a shrinking parameter list) are
  breaking, an *existing* parameter tightened from optional to required in
  place (matched by position, e.g. `send(to, subject?)` -> `send(to,
  subject)`, no change in parameter count) is breaking, an
  optional-to-required or newly-added-required field on an `interface`/`type`
  is breaking, an `enum` member's real effective value changing — including
  the classic "inserted a member above an auto-numbered one and silently
  renumbered everything after it" footgun — is breaking, a generic type
  parameter added to an exported `interface`/`type alias`/`class`/`function`
  with no default (or an existing one losing a default it used to have) is
  breaking — even when the member-level diff sees nothing to flag, e.g. a
  new *optional* field riding along with the new type parameter — because it
  raises the number of explicit type arguments a usage like `Result<string>`
  must supply, everything additive is safe. A real declared TypeScript
  overload set on an exported function or class method (`send(a: string):
  void; send(a: Opts): void; send(a) { ... }`) is diffed as a full list of
  call signatures, not collapsed to just one of them — losing a previously
  declared call shape anywhere in that list (by structural match, not just
  position, so reordering or adding an overload is still safe) is breaking.
  A property's declared type, or a function/method's declared return type,
  widening to include `undefined`/`null` where it didn't before (e.g.
  `name: string` -> `name: string | undefined`, or `getName(): string` ->
  `getName(): string | undefined`) is breaking — existing callers that use
  the value directly with no null/undefined check will fail to type-check
  under strict null checks. A class member flipping between `static` and
  instance (e.g. `static send(a: string): void {}` -> `send(a: string):
  void {}`, same name, same params) is breaking in either direction —
  confirmed against the real compiler: existing callers written as
  `Client.send(x)` or `new Client().send(x)` fail to type-check against the
  other shape, even though nothing else about the member changed. A property
  on an `interface`/`type`/class gaining the `readonly` modifier (same name,
  same type, nothing else about it changed) is breaking — confirmed against
  the real compiler (`TS2540: Cannot assign to '...' because it is a
  read-only property`); dropping `readonly` only loosens what callers may do
  and is never flagged. A method declared with TypeScript's shorthand method
  syntax inside an object-shaped `type` alias (e.g. `type Handlers = {
  onData(chunk: string): void }`, as opposed to an arrow/function-typed
  property) is diffed the same way as an `interface` method — removing one
  is breaking.
- Writes `CHANGELOG.md` (developer-facing, with commit/PR links) and
  `RELEASE_NOTES.md` (same data, plain language, no hashes) with a
  verification banner at the top of each release. Exits with status `2`
  when it finds an undeclared breaking change, so it can gate a CI release
  job.
- `surfacenotes watch` — a local dev-loop mode: diffs a baseline ref against
  your live working tree (uncommitted edits included) and re-checks every
  time a source file changes, so a breaking API edit is flagged the moment
  it's saved, not the next time someone remembers to run `generate` against
  a tag. See "Local dev loop" below.

## Local dev loop: `surfacenotes watch`

`generate` is after-the-fact — it diffs two refs that already exist. `watch`
is for while you're still writing the change:

```bash
surfacenotes watch \
  --repo /path/to/your/repo \
  --entry packages/sdk/index.ts \
  --from v1.7.2
```

It diffs `v1.7.2` against whatever is actually on disk right now (not a
commit, not a stash — the real files, saved or not), prints a report, then
keeps watching. Every time you save, it re-diffs and reprints:

```
[surfacenotes watch] 14:02:11 — v1.7.2 -> working tree (packages/sdk/index.ts)
  ⚠  1 BREAKING change(s):
    - [required-field-added] SendOptions.idempotencyKey: property "idempotencyKey" was
      added to SendOptions as required (not optional) — existing object literals typed
      as SendOptions that don't set it will now fail type-checking.
```

No files are written and no git state changes — it only reads (`git show`
for the baseline, the real filesystem for your edits). Stop with `Ctrl+C`.
Uses native recursive `fs.watch` where the platform supports it, and falls
back to lightweight polling (a directory signature of file paths + mtimes)
everywhere else, so it behaves the same on Linux as it does on macOS.

## A real catch, not a canned demo

Ran Surfacenotes against every real patch and minor tag-to-tag range in
[`resend/resend-node`](https://github.com/resend/resend-node)'s actual public
history (102 real version pairs, no cherry-picking) to find the exact kind of
case this tool exists for: a release that reads as safe from its version
number alone but genuinely changed the public type surface. 12 of 102 were
flagged; the clearest one:

**`v4.6.0` → `v4.7.0`** (a minor version bump) shipped
[PR #535](https://github.com/resend/resend-node/pull/535), "update types to
allow type narrowing" — and silently converted **22 response types**
(`CreateApiKeyResponse`, `GetContactResponse`, `CreateDomainResponse`, and 19
more) from a loosely-typed interface where `data`/`error` were both
independently nullable:

```ts
export interface CreateApiKeyResponse {
  data: CreateApiKeyResponseSuccess | null;
  error: ErrorResponse | null;
}
```

into a real discriminated union:

```ts
export type CreateApiKeyResponse =
  | { data: CreateApiKeyResponseSuccess; error: null }
  | { data: null; error: ErrorResponse };
```

That's a genuinely better type — but it's also a real breaking change for
any caller whose code happened to rely on the old shape (e.g. constructing
`{ data: null, error: null }` directly, or widening the type before
narrowing it), and it shipped across the entire SDK's response surface with
no `BREAKING CHANGE:` footer and no major version bump. Surfacenotes caught
it because it diffs the actual exported type shape at both refs — not the
commit message.

Scanning also surfaced and fixed two real bugs in Surfacenotes itself along
the way: a crash when an import specifier resolved to a git directory
instead of a file (`src/git.ts`'s `existsAtRef` wasn't checking the git
object was actually a blob), and a false positive where converting
`interface X {...}` to `type X = {...}` (or the much more common real-world
`type X = {...} & OtherNamedType` mixin pattern) was flagged as a breaking
"kind change" even when the actual member shape didn't change. Both fixed
and re-verified against the same real 102-pair scan before either number
above was written down.

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
  flips, enum member value shifts) and intentionally reports ambiguous
  type-text changes as informational rather than guessing.
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

For local iteration before you ever get to a tag, run `surfacenotes watch`
instead — see "Local dev loop" above.

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
