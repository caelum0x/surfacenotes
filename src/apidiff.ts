import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ApiChange, ApiDiffResult } from "./types.js";

interface MemberSurface {
  name: string;
  kind: "method" | "property";
  optional: boolean;
  paramsText: string | null;
  typeText: string;
}

interface ExportSurface {
  name: string;
  kind: "class" | "function" | "interface" | "typeAlias" | "const" | "enum" | "unknown";
  members: MemberSurface[];
  paramsText: string | null;
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

function paramsSignature(sf: ts.SourceFile, params: readonly ts.ParameterDeclaration[]): string {
  return params
    .map((p) => {
      const optional = !!p.questionToken || !!p.initializer;
      const typeText = textOf(sf, p.type);
      return `${textOf(sf, p.name)}${optional ? "?" : ""}:${typeText}`;
    })
    .join(", ");
}

function classMembers(sf: ts.SourceFile, decl: ts.ClassDeclaration): MemberSurface[] {
  const members: MemberSurface[] = [];
  for (const m of decl.members) {
    if (hasNamePrivateHash(m.name as ts.PropertyName | undefined)) continue;
    if (!isPublicMember(m)) continue;
    if (ts.isMethodDeclaration(m) && m.name) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
        typeText: textOf(sf, m.type),
      });
    } else if (ts.isPropertyDeclaration(m) && m.name) {
      members.push({
        name: textOf(sf, m.name),
        kind: "property",
        optional: !!m.questionToken,
        paramsText: null,
        typeText: m.type ? textOf(sf, m.type) : "inferred",
      });
    } else if (ts.isConstructorDeclaration(m)) {
      members.push({
        name: "constructor",
        kind: "method",
        optional: false,
        paramsText: paramsSignature(sf, m.parameters),
        typeText: "void",
      });
    }
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
        typeText: textOf(sf, m.type),
      });
    } else if (ts.isMethodSignature(m)) {
      members.push({
        name: textOf(sf, m.name),
        kind: "method",
        optional: !!m.questionToken,
        paramsText: paramsSignature(sf, m.parameters),
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
        typeText: textOf(sf, m.type),
      });
    }
  }
  return members;
}

function surfaceFromDeclaration(sf: ts.SourceFile, node: ts.Node, name: string): ExportSurface {
  if (ts.isClassDeclaration(node)) {
    return { name, kind: "class", members: classMembers(sf, node), paramsText: null, typeText: "class" };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return {
      name,
      kind: "interface",
      members: interfaceMembers(sf, node),
      paramsText: null,
      typeText: "interface",
    };
  }
  if (ts.isFunctionDeclaration(node)) {
    return {
      name,
      kind: "function",
      members: [],
      paramsText: paramsSignature(sf, node.parameters),
      typeText: textOf(sf, node.type),
    };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    const members = ts.isTypeLiteralNode(node.type) ? typeLiteralMembers(sf, node.type) : [];
    return { name, kind: "typeAlias", members, paramsText: null, typeText: textOf(sf, node.type) };
  }
  if (ts.isEnumDeclaration(node)) {
    const members = node.members.map((m) => ({
      name: textOf(sf, m.name),
      kind: "property" as const,
      optional: false,
      paramsText: null,
      typeText: m.initializer ? textOf(sf, m.initializer) : "auto",
    }));
    return { name, kind: "enum", members, paramsText: null, typeText: "enum" };
  }
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return {
        name,
        kind: "function",
        members: [],
        paramsText: paramsSignature(sf, init.parameters),
        typeText: textOf(sf, init.type),
      };
    }
    return { name, kind: "const", members: [], paramsText: null, typeText: node.type ? textOf(sf, node.type) : "inferred" };
  }
  return { name, kind: "unknown", members: [], paramsText: null, typeText: "unknown" };
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

    if (oldMember.optional && !newMember.optional && (parentKind === "interface" || parentKind === "typeAlias")) {
      changes.push({
        kind: "required-field-added",
        severity: "breaking",
        symbol: `${symbolName}.${name}`,
        detail: `"${name}" on ${symbolName} changed from optional to required — existing callers that omit it will now fail type-checking.`,
      });
    }

    if (oldMember.kind === "method" && newMember.kind === "method") {
      const oldParams = (oldMember.paramsText ?? "").split(", ").filter(Boolean);
      const newParams = (newMember.paramsText ?? "").split(", ").filter(Boolean);
      if (newParams.length > oldParams.length) {
        const added = newParams.slice(oldParams.length);
        const anyRequired = added.some((p) => !p.includes("?:"));
        if (anyRequired) {
          changes.push({
            kind: "signature-narrowed",
            severity: "breaking",
            symbol: `${symbolName}.${name}`,
            detail: `${symbolName}.${name}() gained a new required parameter: ${added.join(", ")}.`,
          });
        }
      }
    }
  }

  for (const [name, newMember] of newByName) {
    if (!oldByName.has(name)) {
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
      changes.push({
        kind: "export-removed",
        severity: "breaking",
        symbol: name,
        detail: `Export "${name}" changed kind from ${oldSurface.kind} to ${newSurface.kind}.`,
      });
      continue;
    }

    if (oldSurface.kind === "function" || newSurface.paramsText !== null) {
      const oldParams = (oldSurface.paramsText ?? "").split(", ").filter(Boolean);
      const newParams = (newSurface.paramsText ?? "").split(", ").filter(Boolean);
      if (newParams.length > oldParams.length) {
        const added = newParams.slice(oldParams.length);
        const anyRequired = added.some((p) => !p.includes("?:"));
        if (anyRequired) {
          changes.push({
            kind: "signature-narrowed",
            severity: "breaking",
            symbol: name,
            detail: `${name}() gained a new required parameter: ${added.join(", ")}.`,
          });
        }
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
