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

interface MemberSurface {
  name: string;
  kind: "method" | "property";
  optional: boolean;
  paramsText: string | null;
  params: ParamSurface[] | null;
  typeText: string;
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
  typeText: string;
}

type SurfaceMap = Map<string, ExportSurface>;

const RESOLVE_CANDIDATES = (p: string) => [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`];

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
  const accessors = new Map<string, { typeText: string }>();
  for (const m of decl.members) {
    if (hasNamePrivateHash(m.name as ts.PropertyName | undefined)) continue;
    if (!isPublicMember(m)) continue;
    if ((ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.name) {
      const name = textOf(sf, m.name);
      const typeText = ts.isGetAccessorDeclaration(m)
        ? m.type
          ? textOf(sf, m.type)
          : "inferred"
        : m.parameters[0]?.type
          ? textOf(sf, m.parameters[0].type)
          : "inferred";
      // Prefer the getter's type when both a getter and setter share a
      // name -- that's the type an external reader (`const x =
      // instance.prop`) actually observes. A setter-only accessor (write
      // without read) falls back to its parameter's type.
      if (!accessors.has(name) || ts.isGetAccessorDeclaration(m)) {
        accessors.set(name, { typeText });
      }
      continue;
    }
    if (ts.isMethodDeclaration(m) && m.name) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
        params: collectParams(sf, m.parameters),
        typeText: textOf(sf, m.type),
      });
    } else if (ts.isPropertyDeclaration(m) && m.name) {
      members.push({
        name: textOf(sf, m.name),
        kind: "property",
        optional: !!m.questionToken,
        paramsText: null,
        params: null,
        typeText: m.type ? textOf(sf, m.type) : "inferred",
      });
    } else if (ts.isConstructorDeclaration(m)) {
      members.push({
        name: "constructor",
        kind: "method",
        optional: false,
        paramsText: paramsSignature(sf, m.parameters),
        params: collectParams(sf, m.parameters),
        typeText: "void",
      });
    }
  }
  for (const [name, info] of accessors) {
    members.push({ name, kind: "property", optional: false, paramsText: null, params: null, typeText: info.typeText });
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
      });
    } else if (ts.isMethodSignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
        params: collectParams(sf, m.parameters),
        typeText: textOf(sf, m.type),
      });
    }
  }
  return members;
}

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
      typeText: "class",
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
      typeText: "interface",
    };
  }
  if (ts.isFunctionDeclaration(node)) {
    return {
      name,
      kind: "function",
      objectShaped: false,
      members: [],
      paramsText: paramsSignature(sf, node.parameters),
      params: collectParams(sf, node.parameters),
      typeText: textOf(sf, node.type),
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
      typeText: textOf(sf, node.type),
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
      typeText: "enum",
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
        typeText: textOf(sf, init.type),
      };
    }
    return {
      name,
      kind: "const",
      objectShaped: false,
      members: [],
      paramsText: null,
      params: null,
      typeText: node.type ? textOf(sf, node.type) : "inferred",
    };
  }
  return { name, kind: "unknown", objectShaped: false, members: [], paramsText: null, params: null, typeText: "unknown" };
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
      }
      continue;
    }

    // direct `export class/function/interface/type/enum/const ...`
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    if (
      ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isFunctionDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name) result.set(stmt.name.text, surfaceFromDeclaration(sf, stmt, stmt.name.text));
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

    if (oldMember.kind === "method" && newMember.kind === "method") {
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
