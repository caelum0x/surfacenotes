// Library entry point — re-exports the pieces of surfacenotes that are
// useful to call programmatically (e.g. from a CI script or another tool),
// as opposed to the `surfacenotes` CLI binary in cli.ts.

export { collectCommits, materializeSnapshot, resolveRef } from "./git.js";
export { parseCommit, parseCommits, groupCommits } from "./commits.js";
export { diffApiSurfaces } from "./apidiff.js";
export { verify } from "./verify.js";
export { renderChangelog, renderReleaseNotes } from "./changelog.js";
export * from "./types.js";
