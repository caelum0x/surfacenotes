import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ApiChange, ApiDiffResult } from "./types.js";

/** One real function/method parameter, kept as structured data (not a
 * serialized string) so comparisons never have to re-split text -- see
 * `ParamSurface` usage note on `paramsSignature` for why that matters. */
interface ParamSurface {
  name: string;
  optional: boolean;
  typeText: string;
  /** true for a `...rest` parameter -- see `arityNarrowed` for why this
   * disables the fixed-arity-shrink check. */
  rest: boolean;
}

/** One generic type parameter on an exported class/interface/type-alias/
 * function, e.g. the `T` in `interface Box<T>` or the `E` in `type
 * Result<T, E = unknown>`. Tracked separately from `ParamSurface` (runtime
 * parameters) -- see `typeParamsNarrowed` for the real break this exists to
 * catch. */
interface TypeParamSurface {
  name: string;
  hasDefault: boolean;
}

interface MemberSurface {
  name: string;
  kind: "method" | "property";
  optional: boolean;
  paramsText: string | null;
  params: ParamSurface[] | null;
  /** Every real call signature for this method, when it's declared with
   * TypeScript overloads (`foo(a: string): void; foo(a: number): void;`) --
   * see `overloadRemoved` for the real break this exists to catch. `null`/
   * absent for non-method members (properties); a single-entry array
   * (identical to `params`) for an ordinary, non-overloaded method. */
  overloadParams?: ParamSurface[][] | null;
  typeText: string;
  /** True when this property's declared type, or this method's declared
   * return type, is a top-level union that includes `undefined`/`null` --
   * see `isNullableTypeNode` for the real break this exists to catch. False
   * (not just "unknown") whenever the type couldn't be resolved at all
   * (no annotation, inferred), which is the conservative/safe default. */
  nullable: boolean;
  /** True for a class member declared with the `static` modifier. Only
   * meaningful on `classMembers()` output -- interfaces/type-literals/enums
   * have no such concept and always carry `false` here. See
   * `staticModifierChanged` for the real break this exists to catch:
   * flipping a member between static and instance (same name, same kind,
   * possibly identical params) is invisible to every other check in this
   * file, since none of them look at how the member is actually called. */
  isStatic: boolean;
  /** True for a property carrying the `readonly` modifier (interface/
   * type-literal property signatures, and class property declarations).
   * Always `false` for methods/accessors/enum members, which have no such
   * modifier. See the `readonly-added` check in `diffMembers` for the real
   * break this exists to catch: a property gaining `readonly` between two
   * snapshots keeps the same name/kind/type, so every other check in this
   * file sees zero structural change, yet every existing writer
   * (`instance.prop = x`) now fails to type-check. Deliberately one-
   * directional -- going the other way (dropping `readonly`) only loosens
   * what callers may do and is never flagged as breaking. */
  readonly: boolean;
}

interface ExportSurface {
  name: string;
  kind: "class" | "function" | "interface" | "typeAlias" | "const" | "enum" | "unknown";
  /** True for `interface X {...}` and `type X = {...}` (an object-literal
   * alias) -- the two are structurally interchangeable for anyone consuming
   * the shape, so converting between them isn't a real breaking change on
   * its own. False for anything else a typeAlias might resolve to (union,
   * primitive, mapped/conditional type, etc.), where a kind change really
   * does mean "this is no longer the same kind of thing". */
  objectShaped: boolean;
  members: MemberSurface[];
  paramsText: string | null;
  params: ParamSurface[] | null;
  /** Every real call signature for this export, when it's a function
   * declared with TypeScript overloads -- same shape and purpose as
   * `MemberSurface.overloadParams`, for top-level exported functions rather
   * than class methods. */
  overloadParams?: ParamSurface[][] | null;
  /** Generic type parameters declared directly on this export (e.g. the
   * `<T, E = unknown>` in `type Result<T, E = unknown> = {...}`) -- empty
   * for non-generic exports and for shapes this differ doesn't resolve type
   * parameters for (default-export expressions, enums, consts). */
  typeParams: TypeParamSurface[];
  typeText: string;
  /** Same meaning as `MemberSurface.nullable`, for this export's own type
   * where one applies directly to the export itself (a top-level function's
   * return type, a `const`'s declared type, a non-object-shaped type
   * alias's target) -- see `isNullableTypeNode`. False for shapes with no
   * single "the type" to check (class, interface, enum, unknown). */
  nullable: boolean;
}

type SurfaceMap = Map<string, ExportSurface>;

/**
 * See the identical constant in `git.ts` for the full rationale: a relative
 * specifier naming a compiled `.js`/`.jsx`/`.mjs`/`.cjs` extension (the
 * `"moduleResolution": "nodenext"`/`"node16"` convention) must resolve to the
 * real `.ts`/`.tsx`/`.mts`/`.cts` source file on disk, not fail to resolve at
 * all. This copy operates on the already-materialized snapshot files on disk
 * (used by `resolveLocalImport`, e.g. for re-export-barrel and
 * `findImportSource` resolution) rather than on git blobs, so it's kept as a
 * separate small function rather than a shared import -- consistent with how
 * `RESOLVE_CANDIDATES` was already duplicated between the two files before
 * this fix.
 */
const JS_OUTPUT_EXT_TO_SOURCE_EXT: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const RESOLVE_CANDIDATES = (p: string) => {
  const ext = path.extname(p);
  const sourceExts = JS_OUTPUT_EXT_TO_SOURCE_EXT[ext];
  if (sourceExts) {
    const base = p.slice(0, p.length - ext.length);
    return [p, ...sourceExts.map((sourceExt) => `${base}${sourceExt}`)];
  }
  return [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`];
};

function resolveLocalImport(fromFile: string, specifier: string, root: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.dirname(fromFile);
  const joined = path.resolve(dir, specifier);
  for (const candidate of RESOLVE_CANDIDATES(joined)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const fileCache = new Map<string, ts.SourceFile>();

function loadSourceFile(absPath: string): ts.SourceFile | null {
  if (fileCache.has(absPath)) return fileCache.get(absPath)!;
  if (!fs.existsSync(absPath)) return null;
  const text = fs.readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  fileCache.set(absPath, sf);
  return sf;
}

function textOf(sf: ts.SourceFile, node: ts.Node | undefined): string {
  if (!node) return "unknown";
  return node.getText(sf).replace(/\s+/g, " ").trim();
}

/** True for the real `undefined` keyword type or the real `null` literal type
 * -- see `isNullableTypeNode` for why this is checked at the AST level
 * instead of via a text match on `typeText` (a type like `Record<string,
 * string | undefined>` or `Array<string | null>` contains the substrings
 * "undefined"/"null" without being nullable *at its own top level*, so a
 * naive string search over `typeText` would false-positive on it). */
function isNullOrUndefinedTypeNode(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return true;
  return false;
}

/**
 * Real breaking change this differ previously had zero visibility into: a
 * property's declared type, or a function/method's declared return type,
 * widened to include `undefined`/`null` at its own top level (e.g. `name:
 * string` -> `name: string | undefined`, or `getName(): string` ->
 * `getName(): string | undefined`) -- a real, common real-world SDK edit
 * (marking a previously-guaranteed response field nullable, or a lookup
 * method starting to return `undefined` on a miss) that's genuinely breaking
 * for every existing caller that used the old value directly with no
 * null/undefined check, confirmed directly against the real compiler
 * (`tsc --strict`): `getName().toUpperCase()`, valid against the old
 * signature, produces a real `error TS18048: 'getName(...)' is possibly
 * 'undefined'` against the new one. Every `MemberSurface`/`ExportSurface`
 * already captured a `typeText` string for its own type/return type, but
 * nothing in this file ever compared it across snapshots at all (the one
 * exception, enum member values, compares a different, non-type field) --
 * this was a real, silent, unchecked gap across the entire file, not a
 * narrow one-line miss. Only fires on a top-level union directly on the
 * type/return-type node itself (handles the plain `T | undefined` case and
 * the bare `undefined`/`null` keyword alone); deliberately does not try to
 * resolve `Undefinable<T>`-style type aliases, consistent with this
 * differ's documented heuristic scope.
 */
function isNullableTypeNode(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (isNullOrUndefinedTypeNode(node)) return true;
  if (ts.isUnionTypeNode(node)) return node.types.some(isNullOrUndefinedTypeNode);
  return false;
}

function isPublicMember(member: ts.ClassElement): boolean {
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (!mods) return true;
  return !mods.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function hasNamePrivateHash(name: ts.PropertyName | undefined): boolean {
  return !!name && ts.isPrivateIdentifier(name);
}

/**
 * True when `member` carries the `static` modifier. Flipping a class member
 * between static and instance while keeping its name, kind, and even its
 * parameter list identical (e.g. `static send(a: string): void {}` ->
 * `send(a: string): void {}`) is a real breaking change -- callers of the
 * old shape wrote `Client.send(x)`, callers of the new shape must write
 * `new Client().send(x)` instead -- confirmed directly against the real
 * compiler (`tsc --strict`): the old call site produces a real `error
 * TS2339: Property 'send' does not exist on type 'typeof Client'` against
 * the new shape. Nothing else in this file looks at how a member is
 * actually invoked, so this was completely invisible before: same name,
 * same `kind`, same `params` -> zero structural changes detected.
 */
function hasStaticModifier(member: ts.ClassElement): boolean {
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * True when `node` (a class property declaration, or an interface/
 * type-literal property *signature*) carries the `readonly` modifier.
 * Checked the same way regardless of which of those three node kinds it
 * is -- `ts.canHaveModifiers`/`ts.getModifiers` work generically across all
 * of them, unlike `hasStaticModifier` above which is class-only.
 */
function hasReadonlyModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
}

/**
 * Structured per-parameter data for a function/method signature. This is
 * what every structural comparison must use -- NOT a serialized "name:type,
 * name:type" string re-split on ", ". A parameter's own type text can
 * legitimately contain ", " (a two-arg generic like `Map<string, number>`,
 * an inline object-type literal with multiple properties, a tuple, etc.),
 * and splitting the joined string back apart on that separator miscounts
 * the real parameter list -- confirmed as a real false positive via a
 * synthetic repro: adding a harmless *optional* `b?: Map<string, number>`
 * property to a function's existing object-typed parameter got misread as
 * "gained a new required parameter" purely because of the comma inside
 * `Map<string, number>`, and exited with the tool's own "VERIFIED BREAKING
 * CHANGE" banner for a change that was actually 100% additive.
 */
function collectParams(sf: ts.SourceFile, params: readonly ts.ParameterDeclaration[]): ParamSurface[] {
  return params.map((p) => ({
    name: textOf(sf, p.name),
    optional: !!p.questionToken || !!p.initializer,
    typeText: textOf(sf, p.type),
    rest: !!p.dotDotDotToken,
  }));
}

/** Human-readable "name:type, name:type" rendering for display only --
 * never fed back into a structural comparison (see `collectParams`). */
function formatParams(params: ParamSurface[]): string {
  return params.map((p) => `${p.name}${p.optional ? "?" : ""}:${p.typeText}`).join(", ");
}

function paramsSignature(sf: ts.SourceFile, params: readonly ts.ParameterDeclaration[]): string {
  return formatParams(collectParams(sf, params));
}

/**
 * Params appended after the old list's length that are themselves required
 * (no `?`, no default). Operates on structured `ParamSurface[]`, never on a
 * serialized string -- see `collectParams` for why that distinction is the
 * actual fix here, not cosmetic.
 */
function newlyAddedRequiredParams(
  oldParams: ParamSurface[] | null,
  newParams: ParamSurface[] | null,
): ParamSurface[] {
  const oldList = oldParams ?? [];
  const newList = newParams ?? [];
  if (newList.length <= oldList.length) return [];
  return newList.slice(oldList.length).filter((p) => !p.optional);
}

/**
 * True when the new parameter list is strictly shorter than the old one and
 * neither signature uses a rest parameter (`...args`). TypeScript enforces a
 * hard max-argument-count check against any non-rest signature ("Expected N
 * arguments, but got M") -- confirmed directly against the real compiler
 * (`tsc --strict`) with a synthetic before/after: shrinking an exported
 * `sendEmail(to, subject, body)` down to `sendEmail(to, subject)` makes
 * `sendEmail("a", "b", "c")`, a call site that was valid against the old
 * signature, a real compile error against the new one -- even though the
 * removed parameter wasn't itself marked optional-to-required, nothing here
 * previously checked for a *shrinking* parameter list at all, so this case
 * printed "no breaking changes" and let a mislabeled `fix:` through.
 * Skipped entirely when either signature has a rest parameter, since a rest
 * parameter removes the fixed-arity ceiling this check depends on --
 * consistent with this differ's documented heuristic scope (narrow and
 * confident over exhaustive).
 */
function arityNarrowed(oldParams: ParamSurface[] | null, newParams: ParamSurface[] | null): boolean {
  const oldList = oldParams ?? [];
  const newList = newParams ?? [];
  if (oldList.some((p) => p.rest) || newList.some((p) => p.rest)) return false;
  return newList.length < oldList.length;
}

/**
 * Existing parameters, matched by position (not name -- TypeScript resolves
 * call-site argument compatibility positionally, not by the parameter's own
 * name), that were optional (`?` or a default value) in the old signature
 * and are required in the new one -- independent of `newlyAddedRequiredParams`
 * (which only looks at params appended *past* the old list's length) and
 * `arityNarrowed` (which only fires when the list gets strictly shorter).
 * Neither of those catches the common real-world edit of tightening an
 * *existing* parameter in place, e.g. `sendEmail(to: string, subject?:
 * string)` -> `sendEmail(to: string, subject: string)`: the list length is
 * unchanged on both sides, so `newlyAddedRequiredParams` sees nothing past
 * the old length and `arityNarrowed` sees no shrink -- before this check
 * existed, that edit printed "no structural change(s)" and let a mislabeled
 * `fix:` through. Confirmed as a real break directly against the compiler
 * (`tsc --strict`): a call site valid against the old signature
 * (`sendEmail("a@b.com")`, omitting the now-required `subject`) produces a
 * real `error TS2554: Expected 2 arguments, but got 1` against the new one.
 */
function paramNarrowedToRequired(
  oldParams: ParamSurface[] | null,
  newParams: ParamSurface[] | null,
): ParamSurface[] {
  const oldList = oldParams ?? [];
  const newList = newParams ?? [];
  const overlap = Math.min(oldList.length, newList.length);
  const narrowed: ParamSurface[] = [];
  for (let i = 0; i < overlap; i++) {
    if (oldList[i].optional && !newList[i].optional) {
      narrowed.push(newList[i]);
    }
  }
  return narrowed;
}

/**
 * Given every sibling declaration/class-element that shares one function or
 * method name (a real TypeScript overload set, e.g. `createUser(email:
 * string): string; createUser(opts: Opts): string; createUser(arg: ...): ...
 * { ... }`), return just the nodes an external caller can actually invoke:
 * the bodyless overload *signatures* when any exist, or the single node
 * itself when there's exactly one (the ordinary, non-overloaded case). The
 * body-carrying implementation signature (the last one, with `{ ... }`) is
 * deliberately excluded once real overload signatures exist -- TypeScript
 * itself doesn't let external callers resolve against the implementation
 * signature, only against the declared overloads.
 */
function overloadSignatureNodes<T extends { body?: ts.Block | undefined }>(nodes: T[]): T[] {
  const signatures = nodes.filter((n) => !n.body);
  return signatures.length > 0 ? signatures : nodes;
}

/** Structural equality of one call signature's parameter list -- ignores
 * parameter *names* (TypeScript resolves overload call-site matching by
 * position and type, not by the parameter's own name) but requires the same
 * length and, position-wise, the same optionality/rest-ness/type text. Used
 * only to decide whether a given old overload shape still has an exact
 * match on the new side -- not a general type-compatibility check. */
function signaturesEqual(a: ParamSurface[], b: ParamSurface[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (p, i) => p.optional === b[i].optional && p.rest === b[i].rest && p.typeText === b[i].typeText,
  );
}

/**
 * Real breaking change this differ previously had zero visibility into at
 * all: before this, both `collectExports`' `findLocalDeclaration` (for
 * top-level functions) and `classMembers` (for class methods) only ever
 * captured ONE call signature per name -- `findLocalDeclaration` returns the
 * first matching declaration node it finds, and `classMembers` pushed one
 * `MemberSurface` per overload `ClassElement`, all keyed by the same method
 * name, which `diffMembers`' `new Map(members.map((m) => [m.name, m]))`
 * then silently collapsed down to whichever one was pushed *last* -- so an
 * overloaded function/method's *other* declared call shapes were invisible
 * to the structural diff on both sides, independent of whether any of them
 * actually changed. Confirmed as a real, citable break directly against the
 * compiler: a synthetic repro (`createUser(email: string)` / `createUser
 * (opts: Opts)` narrowed down to just the `opts` overload, committed as a
 * mislabeled `fix:` with no `!`/`BREAKING CHANGE:` footer) printed "API diff
 * found 0 structural change(s)" and exited 0 before this fix; `tsc --strict`
 * on a real caller using the removed `createUser("a@b.com")` shape against
 * the new signature produces a real `error TS2345: Argument of type
 * 'string' is not assignable to parameter of type '{ email: string; name:
 * string; }'`. Matches each old call shape against the new list by
 * structural equality rather than by position, so reordering overloads (or
 * adding a new one) is never mistaken for a loss -- only an old shape with
 * no equal match anywhere on the new side counts as genuinely vanished.
 * Never fires for an ordinary, non-overloaded function/method, since both
 * sides then always have exactly one signature.
 */
function overloadRemoved(
  oldSignatures: ParamSurface[][] | null | undefined,
  newSignatures: ParamSurface[][] | null | undefined,
): { removedCount: number; oldCount: number; newCount: number; example: ParamSurface[] } | null {
  const oldList = oldSignatures ?? [];
  const newList = newSignatures ?? [];
  if (oldList.length <= 1 && newList.length <= 1) return null; // no real overloading on either side
  // Match each old call shape against the new list by structural equality
  // (not position) -- an overload set can be reordered, or a kept overload
  // can slide to a different index, without any real break; only an old
  // shape with *no* exact match anywhere in the new list is a real vanished
  // call signature.
  const removed = oldList.filter((old) => !newList.some((n) => signaturesEqual(old, n)));
  if (removed.length === 0) return null;
  return {
    removedCount: removed.length,
    oldCount: oldList.length,
    newCount: newList.length,
    example: removed[0],
  };
}

function collectTypeParams(
  sf: ts.SourceFile,
  typeParams: readonly ts.TypeParameterDeclaration[] | undefined,
): TypeParamSurface[] {
  if (!typeParams) return [];
  return typeParams.map((tp) => ({
    name: textOf(sf, tp.name),
    hasDefault: !!tp.default,
  }));
}

/**
 * Real breaking change this differ previously had zero visibility into: a
 * generic type parameter added to an exported `interface`/`type
 * alias`/`class`/`function` with no default, or an *existing* type
 * parameter that loses a default it used to have. Both make every usage
 * that supplies fewer explicit type arguments than the new parameter list
 * requires a real compile error -- confirmed directly against the real
 * compiler (`tsc --strict`): adding a second, no-default type parameter to
 * an exported `type Result<T> = {...}` (even when the only new *member* it
 * carries is optional, so the existing field-level checks see nothing to
 * flag) turns `const r: Result<string> = {...}` from valid into a real
 * `error TS2314: Generic type 'Result' requires 2 type argument(s).` on a
 * completely unrelated caller. Before this check existed, that exact range
 * printed "no breaking changes" and let a mislabeled `fix:` through, same
 * failure class as every other gap found in this file, just for generic
 * arity instead of runtime parameter arity. Params already at the same
 * position with a default on both sides are unaffected -- callers that
 * relied on the default can still omit it.
 */
function typeParamsNarrowed(
  oldParams: TypeParamSurface[],
  newParams: TypeParamSurface[],
): TypeParamSurface[] {
  const narrowed: TypeParamSurface[] = [];
  if (newParams.length > oldParams.length) {
    narrowed.push(...newParams.slice(oldParams.length).filter((p) => !p.hasDefault));
  }
  const overlap = Math.min(oldParams.length, newParams.length);
  for (let i = 0; i < overlap; i++) {
    if (oldParams[i].hasDefault && !newParams[i].hasDefault) {
      narrowed.push(newParams[i]);
    }
  }
  return narrowed;
}

function classMembers(sf: ts.SourceFile, decl: ts.ClassDeclaration): MemberSurface[] {
  const members: MemberSurface[] = [];
  /** `get`/`set` accessors are a distinct `ts.ClassElement` kind from both
   * `MethodDeclaration` and `PropertyDeclaration` -- before this, the loop
   * below only matched those two plus the constructor, so an accessor fell
   * through every branch and was silently dropped from the surface on both
   * sides of a diff. Confirmed as a real false negative via a synthetic
   * repro: removing an exported class's only public member, `get
   * apiVersion(): string`, printed "0 structural change(s)" and a clean
   * "API verified: no breaking changes" banner, exit 0 -- a real breaking
   * removal (every external `instance.apiVersion` read now fails to
   * type-check) that the tool's own purpose is to catch, missed because
   * the member was invisible on both the old and new snapshot, not just
   * one of them. A get/set pair sharing a name is merged into one
   * `MemberSurface` here (keyed below) the same way TypeScript itself
   * treats them as a single property from the outside.
   */
  const accessors = new Map<string, { typeText: string; nullable: boolean; isStatic: boolean }>();
  /**
   * Methods and constructors are bucketed by name first, instead of pushed
   * straight into `members` one `ClassElement` at a time, so that a real
   * TypeScript overload set (`send(a: string): void; send(a: Opts): void;
   * send(a: any) { ... }` -- three separate `ClassElement`s sharing one
   * name) is merged into a single `MemberSurface` carrying every real call
   * signature via `overloadParams`, instead of silently collapsing to
   * whichever declaration happened to be pushed last (see `overloadRemoved`
   * for the real break this exists to catch -- the previous one-push-per-
   * element behavior meant the *other* overloads were invisible to the
   * structural diff on both sides, independent of whether any of them
   * actually changed).
   */
  const callableByName = new Map<string, Array<ts.MethodDeclaration | ts.ConstructorDeclaration>>();
  for (const m of decl.members) {
    if (hasNamePrivateHash(m.name as ts.PropertyName | undefined)) continue;
    if (!isPublicMember(m)) continue;
    if ((ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.name) {
      const name = textOf(sf, m.name);
      const typeNode = ts.isGetAccessorDeclaration(m) ? m.type : m.parameters[0]?.type;
      const typeText = typeNode ? textOf(sf, typeNode) : "inferred";
      // Prefer the getter's type when both a getter and setter share a
      // name -- that's the type an external reader (`const x =
      // instance.prop`) actually observes. A setter-only accessor (write
      // without read) falls back to its parameter's type.
      if (!accessors.has(name) || ts.isGetAccessorDeclaration(m)) {
        accessors.set(name, { typeText, nullable: isNullableTypeNode(typeNode), isStatic: hasStaticModifier(m) });
      }
      continue;
    }
    if (ts.isMethodDeclaration(m) && m.name) {
      const name = textOf(sf, m.name);
      const list = callableByName.get(name) ?? [];
      list.push(m);
      callableByName.set(name, list);
    } else if (ts.isPropertyDeclaration(m) && m.name) {
      members.push({
        name: textOf(sf, m.name),
        kind: "property",
        optional: !!m.questionToken,
        paramsText: null,
        params: null,
        typeText: m.type ? textOf(sf, m.type) : "inferred",
        nullable: isNullableTypeNode(m.type),
        isStatic: hasStaticModifier(m),
        readonly: hasReadonlyModifier(m),
      });
    } else if (ts.isConstructorDeclaration(m)) {
      const list = callableByName.get("constructor") ?? [];
      list.push(m);
      callableByName.set("constructor", list);
    }
  }
  for (const [name, decls] of callableByName) {
    const signatureNodes = overloadSignatureNodes(decls);
    const primary = decls[0];
    members.push({
      name,
      kind: "method",
      optional: ts.isMethodDeclaration(primary) ? !!primary.questionToken : false,
      paramsText: paramsSignature(sf, primary.parameters),
      params: collectParams(sf, primary.parameters),
      overloadParams: signatureNodes.map((d) => collectParams(sf, d.parameters)),
      typeText: ts.isMethodDeclaration(primary) ? textOf(sf, primary.type) : "void",
      nullable: ts.isMethodDeclaration(primary) ? isNullableTypeNode(primary.type) : false,
      // `primary` (the first declaration pushed for this name) decides
      // static-ness, same "primary wins" convention already used above for
      // params/type when a name has multiple overload declarations -- a
      // name mixing a static and an instance overload under the same name
      // is itself vanishingly rare and out of this differ's documented
      // heuristic scope.
      isStatic: hasStaticModifier(primary),
      // Methods have no `readonly` modifier concept.
      readonly: false,
    });
  }
  for (const [name, info] of accessors) {
    members.push({
      name,
      kind: "property",
      optional: false,
      paramsText: null,
      params: null,
      typeText: info.typeText,
      nullable: info.nullable,
      isStatic: info.isStatic,
      // A get/set accessor pair has no `readonly` *modifier* -- its
      // writability is governed by whether a setter exists at all, a
      // separate check outside this one's scope (see `readonly` field doc
      // on `MemberSurface`).
      readonly: false,
    });
  }
  return members;
}

function interfaceMembers(sf: ts.SourceFile, decl: ts.InterfaceDeclaration): MemberSurface[] {
  const members: MemberSurface[] = [];
  for (const m of decl.members) {
    if (!m.name) continue;
    if (ts.isPropertySignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "property",
        optional: !!m.questionToken,
        paramsText: null,
        params: null,
        typeText: textOf(sf, m.type),
        nullable: isNullableTypeNode(m.type),
        isStatic: false,
        readonly: hasReadonlyModifier(m),
      });
    } else if (ts.isMethodSignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
        params: collectParams(sf, m.parameters),
        typeText: textOf(sf, m.type),
        nullable: isNullableTypeNode(m.type),
        isStatic: false,
        readonly: false,
      });
    }
  }
  return members;
}

/**
 * Real false negative this differ previously had zero visibility into: a
 * member declared with TypeScript's method-shorthand syntax inside a
 * `TypeLiteral` (`type Handlers = { onData(chunk: string): void }`) parses
 * as a distinct `ts.MethodSignature` AST node, not a `PropertySignature` --
 * this loop only ever matched the latter, so a method-shaped member on an
 * object-shaped `type` alias (or the type-literal half of an intersection,
 * via `objectShapedMembers`) was silently dropped from the surface on BOTH
 * snapshots, the same "invisible on both sides" failure class as the class
 * accessor bug fixed in `60fca38`. This is a real, common real-world shape
 * for exactly the kind of exported type this tool's audience writes (a
 * typed event-handler/callback bag passed into an SDK method, e.g. `type
 * Handlers = { onData(chunk: Buffer): void; onEnd(): void }`), as opposed to
 * an `interface` declaring the same shape -- confirmed as a real gap via a
 * synthetic repro (`/tmp/sn-typelit-method-test`, two tags): removing
 * `onEnd()` entirely from such a type alias, committed as a mislabeled
 * `fix:` with no `!`/`BREAKING CHANGE:` footer, printed "API diff found 0
 * structural change(s)" and a clean "no breaking changes" verdict, exit 0 --
 * before this fix, the member was never collected in the first place, so
 * none of the file's existing per-member checks (which already treat a
 * removed interface/type-alias member as breaking, consistently, via
 * `diffMembers`'s generic `member-removed` path) ever ran against it.
 * Mirrors `interfaceMembers`' `ts.isMethodSignature` handling exactly, since
 * a type-literal method signature and an interface method signature are the
 * same AST node kind with the same structural meaning.
 */
function typeLiteralMembers(sf: ts.SourceFile, node: ts.TypeLiteralNode): MemberSurface[] {
  const members: MemberSurface[] = [];
  for (const m of node.members) {
    if (!m.name) continue;
    if (ts.isPropertySignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "property",
        optional: !!m.questionToken,
        paramsText: null,
        params: null,
        typeText: textOf(sf, m.type),
        nullable: isNullableTypeNode(m.type),
        isStatic: false,
        readonly: hasReadonlyModifier(m),
      });
    } else if (ts.isMethodSignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
        params: collectParams(sf, m.parameters),
        typeText: textOf(sf, m.type),
        nullable: isNullableTypeNode(m.type),
        isStatic: false,
        readonly: false,
      });
    }
  }
  return members;
}

/**
 * Enum members, carrying each member's real *effective* value (not just its
 * literal initializer text) so a value shift can be diffed later. A numeric
 * enum member with no initializer isn't actually valueless -- TypeScript
 * auto-assigns it `previousNumericValue + 1` (0 for the first member) -- so
 * inserting a new member before an existing auto-numbered one silently
 * renumbers every member after it, a real, citable TypeScript footgun
 * (`enum Direction { Up, Down, Left, Right }` with `Down`/`Left`/`Right` all
 * shifting by one once a member is inserted above them) that's genuinely
 * breaking for any code or stored data comparing against the old numeric
 * value, yet was previously invisible to this differ entirely: the old
 * per-member text was literally the string `"auto"` on both sides of such a
 * diff, so two differently-numbered enums compared as identical. Only the
 * common, unambiguous auto-numbering chain (explicit numeric literal, or no
 * initializer following one) is resolved; anything the TS auto-numbering
 * rules themselves don't define cleanly (e.g. no initializer immediately
 * after a string-valued member) is marked `"auto (unresolvable)"` and
 * deliberately excluded from the value-changed comparison below, consistent
 * with this differ's documented heuristic scope.
 */
function enumMembers(sf: ts.SourceFile, decl: ts.EnumDeclaration): MemberSurface[] {
  let autoCounter = 0;
  let autoCounterValid = true;
  return decl.members.map((m) => {
    let valueText: string;
    if (m.initializer) {
      valueText = textOf(sf, m.initializer);
      if (ts.isNumericLiteral(m.initializer)) {
        autoCounter = Number(m.initializer.text) + 1;
        autoCounterValid = true;
      } else {
        autoCounterValid = false;
      }
    } else if (autoCounterValid) {
      valueText = String(autoCounter);
      autoCounter += 1;
    } else {
      valueText = "auto (unresolvable)";
    }
    return {
      name: textOf(sf, m.name),
      kind: "property" as const,
      optional: false,
      paramsText: null,
      params: null,
      typeText: valueText,
      nullable: false,
      isStatic: false,
      readonly: false,
    };
  });
}

/**
 * Is `node` the kind of type-alias target that's structurally the same
 * sort of thing as an interface -- so converting between the two isn't a
 * real breaking change on its own? Handles the plain `type X = {...}` case
 * and the much more common real-world `type X = {...} & OtherNamedType`
 * mixin pattern (e.g. resend-node's `GetContactOptions = { audienceId:
 * string } & SelectingField`). Deliberately excludes unions, function
 * types, primitives, mapped/conditional types, and a bare reference with
 * no literal anywhere in it -- those really are a different kind of thing
 * than an interface, and a kind change there is real signal.
 */
function isObjectShapedTypeNode(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return true;
  if (ts.isIntersectionTypeNode(node)) {
    const hasLiteral = node.types.some((t) => ts.isTypeLiteralNode(t));
    const hasIncompatible = node.types.some(
      (t) => ts.isUnionTypeNode(t) || ts.isFunctionTypeNode(t) || ts.isConditionalTypeNode(t),
    );
    return hasLiteral && !hasIncompatible;
  }
  return false;
}

/** Collects members from every type-literal constituent of an intersection
 * (e.g. the `{ audienceId: string }` half of `{...} & SelectingField`) --
 * the named-reference half can't be resolved without full cross-file type
 * resolution, so it's left out; this is a partial, heuristic surface, not
 * an exhaustive one, consistent with the rest of this differ. */
function objectShapedMembers(sf: ts.SourceFile, node: ts.TypeNode): MemberSurface[] {
  if (ts.isTypeLiteralNode(node)) return typeLiteralMembers(sf, node);
  if (ts.isIntersectionTypeNode(node)) {
    return node.types
      .filter((t): t is ts.TypeLiteralNode => ts.isTypeLiteralNode(t))
      .flatMap((t) => typeLiteralMembers(sf, t));
  }
  return [];
}

function surfaceFromDeclaration(sf: ts.SourceFile, node: ts.Node, name: string): ExportSurface {
  if (ts.isClassDeclaration(node)) {
    return {
      name,
      kind: "class",
      objectShaped: false,
      members: classMembers(sf, node),
      paramsText: null,
      params: null,
      typeParams: collectTypeParams(sf, node.typeParameters),
      typeText: "class",
      nullable: false,
    };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return {
      name,
      kind: "interface",
      objectShaped: true,
      members: interfaceMembers(sf, node),
      paramsText: null,
      params: null,
      typeParams: collectTypeParams(sf, node.typeParameters),
      typeText: "interface",
      nullable: false,
    };
  }
  if (ts.isFunctionDeclaration(node)) {
    // A top-level exported function can be declared with real TypeScript
    // overloads -- several sibling `FunctionDeclaration` statements sharing
    // one name in `sf.statements` (e.g. `export function createUser(email:
    // string): string; export function createUser(opts: Opts): string;
    // export function createUser(arg) { ... }`). `node` here is whichever
    // one `findLocalDeclaration` happened to find first; `overloadParams`
    // below independently re-collects every sibling so no overload is lost
    // just because `node` isn't the whole set -- see `overloadRemoved`.
    const siblingName = node.name?.text;
    const siblings = siblingName
      ? sf.statements.filter(
          (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === siblingName,
        )
      : [node];
    const signatureNodes = overloadSignatureNodes(siblings);
    return {
      name,
      kind: "function",
      objectShaped: false,
      members: [],
      paramsText: paramsSignature(sf, node.parameters),
      params: collectParams(sf, node.parameters),
      overloadParams: signatureNodes.map((s) => collectParams(sf, s.parameters)),
      typeParams: collectTypeParams(sf, node.typeParameters),
      typeText: textOf(sf, node.type),
      nullable: isNullableTypeNode(node.type),
    };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    const objectShaped = isObjectShapedTypeNode(node.type);
    const members = objectShaped ? objectShapedMembers(sf, node.type) : [];
    return {
      name,
      kind: "typeAlias",
      objectShaped,
      members,
      paramsText: null,
      params: null,
      typeParams: collectTypeParams(sf, node.typeParameters),
      typeText: textOf(sf, node.type),
      // Object-shaped aliases (`type X = {...}`) already get field-level
      // nullable-widening coverage via `objectShapedMembers`'s member diff
      // above -- only a non-object-shaped alias (`type Timeout = number`)
      // has "the type itself" as a meaningful, separate nullable check.
      nullable: !objectShaped && isNullableTypeNode(node.type),
    };
  }
  if (ts.isEnumDeclaration(node)) {
    return {
      name,
      kind: "enum",
      objectShaped: false,
      members: enumMembers(sf, node),
      paramsText: null,
      params: null,
      typeParams: [],
      typeText: "enum",
      nullable: false,
    };
  }
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return {
        name,
        kind: "function",
        objectShaped: false,
        members: [],
        paramsText: paramsSignature(sf, init.parameters),
        params: collectParams(sf, init.parameters),
        typeParams: collectTypeParams(sf, init.typeParameters),
        typeText: textOf(sf, init.type),
        nullable: isNullableTypeNode(init.type),
      };
    }
    return {
      name,
      kind: "const",
      objectShaped: false,
      members: [],
      paramsText: null,
      params: null,
      typeParams: [],
      typeText: node.type ? textOf(sf, node.type) : "inferred",
      nullable: isNullableTypeNode(node.type),
    };
  }
  return {
    name,
    kind: "unknown",
    objectShaped: false,
    members: [],
    paramsText: null,
    params: null,
    typeParams: [],
    nullable: false,
    typeText: "unknown",
  };
}

/** Find a top-level declaration named `name` anywhere in the file (exported or not). */
function findLocalDeclaration(sf: ts.SourceFile, name: string): { node: ts.Node } | null {
  for (const stmt of sf.statements) {
    if (
      (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isFunctionDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      stmt.name?.text === name
    ) {
      return { node: stmt };
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return { node: decl };
      }
    }
  }
  return null;
}

/**
 * For a bare `export { X }` / `export type { X }` with no `from` clause, X's real origin is
 * either a local declaration (handled by `findLocalDeclaration`) or an `import { X } from
 * "./y"` elsewhere in the same file — common in hand-written barrels that only ever import a
 * type to immediately re-export it, never declare it locally (e.g. `import type { Foo } from
 * "./types"; export type { Foo };`). Without following this, the structural differ silently
 * treats `Foo` as unresolved and the breaking-change check never sees it at all — a false
 * negative, the one failure mode worse than a false positive for this tool's actual purpose.
 * Handles `import { Foo as Bar }` aliasing; does not follow `import * as ns from` namespace
 * imports (same documented heuristic-scope limit as the rest of this differ).
 */
function findImportSource(sf: ts.SourceFile, localName: string, root: string): { targetFile: string; importedName: string } | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const namedBindings = stmt.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const el of namedBindings.elements) {
      if (el.name.text !== localName) continue;
      const importedName = (el.propertyName ?? el.name).text;
      const targetFile = resolveLocalImport(sf.fileName, stmt.moduleSpecifier.text, root);
      if (targetFile) return { targetFile, importedName };
    }
  }
  return null;
}

/**
 * Resolve every export reachable from `entryFile`, following re-export
 * barrels (`export { X } from './y'`, `export * from './y'`) and local
 * declarations, into a flat map of exported-name -> structural surface.
 */
function collectExports(
  entryFile: string,
  root: string,
  unresolved: string[],
  visited = new Set<string>(),
): SurfaceMap {
  const result: SurfaceMap = new Map();
  if (visited.has(entryFile)) return result;
  visited.add(entryFile);

  const sf = loadSourceFile(entryFile);
  if (!sf) {
    unresolved.push(entryFile);
    return result;
  }

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      const moduleSpecifier =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      const targetFile = moduleSpecifier ? resolveLocalImport(entryFile, moduleSpecifier, root) : null;

      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const localName = (el.propertyName ?? el.name).text;
          const exportedAs = el.name.text;
          if (targetFile) {
            const targetSurfaces = collectExports(targetFile, root, unresolved, visited);
            const found = targetSurfaces.get(localName);
            if (found) {
              result.set(exportedAs, { ...found, name: exportedAs });
              continue;
            }
            // not a re-export barrel entry; look for a direct declaration in the target file
            const targetSf = loadSourceFile(targetFile);
            const direct = targetSf && findLocalDeclaration(targetSf, localName);
            if (direct && targetSf) {
              result.set(exportedAs, surfaceFromDeclaration(targetSf, direct.node, exportedAs));
              continue;
            }
            unresolved.push(`${exportedAs} from ${moduleSpecifier} (via ${entryFile})`);
          } else {
            const direct = findLocalDeclaration(sf, localName);
            if (direct) {
              result.set(exportedAs, surfaceFromDeclaration(sf, direct.node, exportedAs));
              continue;
            }
            const imported = findImportSource(sf, localName, root);
            const importedSurfaces = imported ? collectExports(imported.targetFile, root, unresolved, visited) : null;
            const foundImported = imported && importedSurfaces?.get(imported.importedName);
            if (foundImported) {
              result.set(exportedAs, { ...foundImported, name: exportedAs });
            } else {
              unresolved.push(`${exportedAs} (local, via ${entryFile})`);
            }
          }
        }
      } else if (!stmt.exportClause && targetFile) {
        // export * from "./y"
        for (const [name, surface] of collectExports(targetFile, root, unresolved, visited)) {
          result.set(name, surface);
        }
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause) && targetFile) {
        // `export * as NS from "./y"` -- a distinct `NamespaceExport` exportClause kind,
        // not `NamedExports` and not the `undefined` clause the `export * from` branch
        // above checks for, so this fell through both branches and was completely
        // invisible to the differ on both snapshots -- the same "invisible on both sides"
        // false-negative class as the `export default` gap fixed in `5d2a88a`, just for a
        // different re-export AST shape. A common real pattern for exactly this tool's
        // audience: an SDK grouping its request/response types under a namespace, e.g.
        // `export * as Types from "./types"`, then consumers import as
        // `import { Types } from "pkg"; const x: Types.SendOptions = ...`. Every export
        // under the namespace becomes reachable as "NS.subName", so it's tracked under
        // that qualified key through the exact same diffSurfaces()/diffMembers() path as
        // every other export -- the "." splits the same way rootSymbol() (verify.ts) and
        // the existing class-member symbol format ("Client.send()") already expect.
        const nsName = stmt.exportClause.name.text;
        for (const [name, surface] of collectExports(targetFile, root, unresolved, visited)) {
          result.set(`${nsName}.${name}`, { ...surface, name: `${nsName}.${name}` });
        }
      }
      continue;
    }

    // `export default <expr>;` -- a distinct `ExportAssignment` node, not an
    // `ExportDeclaration` and not a modifier on a class/function/etc, so it
    // fell through every branch below and was completely invisible to the
    // differ on both sides of a diff -- the same "invisible on both
    // snapshots" false-negative class as the get/set accessor bug fixed in
    // `60fca38`, just for a different AST shape. This is a real, common
    // pattern for exactly the kind of package this tool targets (a client
    // SDK's main class declared separately, then `export default Client;`
    // at the bottom of the entry file -- e.g. stripe-node's historical
    // `export default Stripe;`). Resolves the common real-world shapes:
    // a plain identifier referring to a local declaration or a re-exported
    // import (reusing `findLocalDeclaration`/`findImportSource` exactly as
    // the bare `export { X }` path above does), or an inline anonymous
    // function/arrow/class expression. Anything else (a call expression,
    // object literal composed at runtime, etc.) is honestly reported as
    // unresolved rather than silently dropped.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      if (ts.isIdentifier(expr)) {
        const direct = findLocalDeclaration(sf, expr.text);
        if (direct) {
          result.set("default", surfaceFromDeclaration(sf, direct.node, "default"));
        } else {
          const imported = findImportSource(sf, expr.text, root);
          const importedSurfaces = imported ? collectExports(imported.targetFile, root, unresolved, visited) : null;
          const foundImported = imported && importedSurfaces?.get(imported.importedName);
          if (foundImported) {
            result.set("default", { ...foundImported, name: "default" });
          } else {
            unresolved.push(`default export "${expr.text}" (via ${entryFile})`);
          }
        }
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        result.set("default", {
          name: "default",
          kind: "function",
          objectShaped: false,
          members: [],
          paramsText: paramsSignature(sf, expr.parameters),
          params: collectParams(sf, expr.parameters),
          typeParams: collectTypeParams(sf, expr.typeParameters),
          typeText: textOf(sf, expr.type),
          nullable: isNullableTypeNode(expr.type),
        });
      } else if (ts.isClassExpression(expr)) {
        result.set("default", {
          name: "default",
          kind: "class",
          objectShaped: false,
          members: classMembers(sf, expr as unknown as ts.ClassDeclaration),
          paramsText: null,
          params: null,
          typeParams: collectTypeParams(sf, expr.typeParameters),
          typeText: "class",
          nullable: false,
        });
      } else {
        unresolved.push(`default export expression (via ${entryFile}, not a resolvable shape)`);
      }
      continue;
    }

    // direct `export class/function/interface/type/enum/const ...`
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    // `export default class Foo {...}` / `export default function foo() {}`
    // carry both the `export` and `default` modifiers on the same
    // declaration (as opposed to the `ExportAssignment` form handled above).
    // Before this, such a declaration got keyed by its *local* name (`Foo`)
    // -- cosmetically wrong, and fatally wrong for the common anonymous form
    // (`export default class { ... }`, `export default function () {}`),
    // which has no name at all and was silently skipped entirely, invisible
    // to the differ on both sides.
    const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (
      ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isFunctionDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    ) {
      if (isDefault) {
        result.set("default", surfaceFromDeclaration(sf, stmt, "default"));
      } else if (stmt.name) {
        result.set(stmt.name.text, surfaceFromDeclaration(sf, stmt, stmt.name.text));
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          result.set(decl.name.text, surfaceFromDeclaration(sf, decl, decl.name.text));
        }
      }
    }
  }

  return result;
}

function diffMembers(symbolName: string, oldMembers: MemberSurface[], newMembers: MemberSurface[], parentKind: ExportSurface["kind"]): ApiChange[] {
  const changes: ApiChange[] = [];
  const oldByName = new Map(oldMembers.map((m) => [m.name, m]));
  const newByName = new Map(newMembers.map((m) => [m.name, m]));

  for (const [name, oldMember] of oldByName) {
    const newMember = newByName.get(name);
    if (!newMember) {
      changes.push({
        kind: "member-removed",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: `${oldMember.kind} "${name}" was removed from ${symbolName}.`,
      });
      continue;
    }

    if (
      parentKind === "enum" &&
      oldMember.typeText !== newMember.typeText &&
      oldMember.typeText !== "auto (unresolvable)" &&
      newMember.typeText !== "auto (unresolvable)"
    ) {
      changes.push({
        kind: "enum-value-changed",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: `Enum member "${name}" on ${symbolName} changed value from ${oldMember.typeText} to ${newMember.typeText} — any code or stored data comparing against the old value will no longer match.`,
      });
    }

    if (oldMember.optional && !newMember.optional && (parentKind === "interface" || parentKind === "typeAlias")) {
      changes.push({
        kind: "required-field-added",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: `"${name}" on ${symbolName} changed from optional to required — existing callers that omit it will now fail type-checking.`,
      });
    }

    if (parentKind === "class" && oldMember.isStatic !== newMember.isStatic) {
      changes.push({
        kind: "static-modifier-changed",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: oldMember.isStatic
          ? `${symbolName}.${name} changed from a static member to an instance member — existing callers using "${symbolName}.${name}(...)" directly on the class will now fail to type-check; it must be called on an instance instead.`
          : `${symbolName}.${name} changed from an instance member to a static member — existing callers using "instance.${name}(...)" will now fail to type-check; it must be called on the class itself instead.`,
      });
    }

    if (newMember.kind === "property" && !oldMember.readonly && newMember.readonly) {
      changes.push({
        kind: "readonly-added",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: `"${name}" on ${symbolName} gained the "readonly" modifier — existing code that writes to it directly (e.g. "instance.${name} = ...") will now fail to type-check.`,
      });
    }

    if (!oldMember.nullable && newMember.nullable) {
      changes.push({
        kind: "type-widened-nullable",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail:
          newMember.kind === "method"
            ? `${symbolName}.${name}()'s return type now includes undefined/null where it didn't before — existing callers that use the result directly without a null/undefined check will fail to type-check under strict null checks.`
            : `"${name}" on ${symbolName} now includes undefined/null in its type where it didn't before — existing callers that use the value directly without a null/undefined check will fail to type-check under strict null checks.`,
      });
    }

    if (oldMember.kind === "method" && newMember.kind === "method") {
      const overloadLoss = overloadRemoved(oldMember.overloadParams, newMember.overloadParams);
      if (overloadLoss) {
        changes.push({
          kind: "overload-removed",
          severity: "breaking",
          symbol: `${symbolName}.${name}`,
          detail: `${symbolName}.${name}() lost ${overloadLoss.removedCount} overload signature(s) (had ${overloadLoss.oldCount}, now ${overloadLoss.newCount}) — e.g. a call shaped like (${formatParams(overloadLoss.example)}) is no longer callable.`,
        });
      }
      const addedRequired = newlyAddedRequiredParams(oldMember.params, newMember.params);
      if (addedRequired.length > 0) {
        changes.push({
          kind: "signature-narrowed",
          severity: "breaking",
          symbol: `${symbolName}.${name}`,
          detail: `${symbolName}.${name}() gained a new required parameter: ${formatParams(addedRequired)}.`,
        });
      } else if (arityNarrowed(oldMember.params, newMember.params)) {
        changes.push({
          kind: "param-removed",
          severity: "breaking",
          symbol: `${symbolName}.${name}`,
          detail: `${symbolName}.${name}() now takes only ${(newMember.params ?? []).length} parameter(s), down from ${(oldMember.params ?? []).length} — existing callers passing more arguments than the new signature allows will fail to type-check.`,
        });
      }
      const narrowedParams = paramNarrowedToRequired(oldMember.params, newMember.params);
      if (narrowedParams.length > 0) {
        changes.push({
          kind: "param-became-required",
          severity: "breaking",
          symbol: `${symbolName}.${name}`,
          detail: `${symbolName}.${name}()'s parameter(s) ${narrowedParams.map((p) => `"${p.name}"`).join(", ")} changed from optional to required — existing callers that omitted them will now fail to type-check.`,
        });
      }
    }
  }

  for (const [name, newMember] of newByName) {
    if (!oldByName.has(name)) {
      // A brand new member is genuinely additive for a *class* (existing
      // instances/subclasses don't have to supply it) and for an optional
      // member on any shape. But a new non-optional property/method on an
      // `interface`/object-shaped `type` alias is breaking for every caller
      // that builds the shape via an object literal (`const x: Foo = {...}`,
      // a function parameter typed as `Foo`, etc.) -- TypeScript will now
      // reject every one of those call sites for missing the new required
      // field. Reuses the same `required-field-added` kind as the
      // optional-to-required transition above since the caller impact is
      // identical: a field that used to be omittable no longer is.
      const isNewRequiredShapeMember =
        (parentKind === "interface" || parentKind === "typeAlias") && !newMember.optional;
      if (isNewRequiredShapeMember) {
        changes.push({
          kind: "required-field-added",
          severity: "breaking",
          symbol: `${symbolName}.${name}`,
          detail: `${newMember.kind} "${name}" was added to ${symbolName} as required (not optional) — existing object literals typed as ${symbolName} that don't set it will now fail type-checking.`,
        });
        continue;
      }
      changes.push({
        kind: "member-added",
        severity: "safe",
        symbol: `${symbolName}.${name}`,
        detail: `${newMember.kind} "${name}" was added to ${symbolName}.`,
      });
    }
  }

  return changes;
}

function diffSurfaces(oldMap: SurfaceMap, newMap: SurfaceMap): ApiChange[] {
  const changes: ApiChange[] = [];

  for (const [name, oldSurface] of oldMap) {
    const newSurface = newMap.get(name);
    if (!newSurface) {
      changes.push({
        kind: "export-removed",
        severity: "breaking",
        symbol: name,
        detail: `Export "${name}" (${oldSurface.kind}) was removed from the package's public entry point.`,
      });
      continue;
    }

    if (oldSurface.kind !== newSurface.kind) {
      // `interface X {...}` <-> `type X = {...}` is a pure declaration-
      // syntax choice; consumers assigning/destructuring the shape can't
      // tell the difference. Don't flag the kind change itself -- fall
      // through to the member diff below, which still catches a real
      // breaking change (a dropped or newly-required field) if one
      // happened to ride along with the conversion.
      if (!(oldSurface.objectShaped && newSurface.objectShaped)) {
        changes.push({
          kind: "export-removed",
          severity: "breaking",
          symbol: name,
          detail: `Export "${name}" changed kind from ${oldSurface.kind} to ${newSurface.kind}.`,
        });
        continue;
      }
    }

    if (oldSurface.kind === "function" || newSurface.params !== null) {
      const overloadLoss = overloadRemoved(oldSurface.overloadParams, newSurface.overloadParams);
      if (overloadLoss) {
        changes.push({
          kind: "overload-removed",
          severity: "breaking",
          symbol: name,
          detail: `${name}() lost ${overloadLoss.removedCount} overload signature(s) (had ${overloadLoss.oldCount}, now ${overloadLoss.newCount}) — e.g. a call shaped like (${formatParams(overloadLoss.example)}) is no longer callable.`,
        });
      }
      const addedRequired = newlyAddedRequiredParams(oldSurface.params, newSurface.params);
      if (addedRequired.length > 0) {
        changes.push({
          kind: "signature-narrowed",
          severity: "breaking",
          symbol: name,
          detail: `${name}() gained a new required parameter: ${formatParams(addedRequired)}.`,
        });
      } else if (arityNarrowed(oldSurface.params, newSurface.params)) {
        changes.push({
          kind: "param-removed",
          severity: "breaking",
          symbol: name,
          detail: `${name}() now takes only ${(newSurface.params ?? []).length} parameter(s), down from ${(oldSurface.params ?? []).length} — existing callers passing more arguments than the new signature allows will fail to type-check.`,
        });
      }
      const narrowedParams = paramNarrowedToRequired(oldSurface.params, newSurface.params);
      if (narrowedParams.length > 0) {
        changes.push({
          kind: "param-became-required",
          severity: "breaking",
          symbol: name,
          detail: `${name}()'s parameter(s) ${narrowedParams.map((p) => `"${p.name}"`).join(", ")} changed from optional to required — existing callers that omitted them will now fail to type-check.`,
        });
      }
    }

    const narrowedTypeParams = typeParamsNarrowed(oldSurface.typeParams, newSurface.typeParams);
    if (narrowedTypeParams.length > 0) {
      changes.push({
        kind: "type-param-narrowed",
        severity: "breaking",
        symbol: name,
        detail: `${name}<...> now requires additional type parameter(s) with no default: ${narrowedTypeParams.map((p) => p.name).join(", ")} — existing usages of "${name}" that don't supply them will fail to type-check.`,
      });
    }

    if (!oldSurface.nullable && newSurface.nullable) {
      changes.push({
        kind: "type-widened-nullable",
        severity: "breaking",
        symbol: name,
        detail:
          newSurface.kind === "function"
            ? `${name}()'s return type now includes undefined/null where it didn't before — existing callers that use the result directly without a null/undefined check will fail to type-check under strict null checks.`
            : `"${name}"'s type now includes undefined/null where it didn't before — existing callers that use the value directly without a null/undefined check will fail to type-check under strict null checks.`,
      });
    }

    changes.push(...diffMembers(name, oldSurface.members, newSurface.members, newSurface.kind));
  }

  for (const [name, newSurface] of newMap) {
    if (!oldMap.has(name)) {
      changes.push({
        kind: "export-added",
        severity: "safe",
        symbol: name,
        detail: `New export "${name}" (${newSurface.kind}) was added to the package's public entry point.`,
      });
    }
  }

  return changes;
}

export function diffApiSurfaces(opts: {
  fromDir: string;
  fromEntry: string;
  toDir: string;
  toEntry: string;
  fromRef: string;
  toRef: string;
}): ApiDiffResult {
  fileCache.clear();
  const unresolvedWarnings: string[] = [];
  const oldMap = collectExports(opts.fromEntry, opts.fromDir, unresolvedWarnings);
  const newMap = collectExports(opts.toEntry, opts.toDir, unresolvedWarnings);
  const changes = diffSurfaces(oldMap, newMap);

  return {
    entryFile: path.relative(opts.toDir, opts.toEntry),
    fromRef: opts.fromRef,
    toRef: opts.toRef,
    changes,
    unresolvedWarnings,
  };
}
