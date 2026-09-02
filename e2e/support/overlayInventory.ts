import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

/**
 * Source-derived overlay inventory for the mobile overflow gate (#1663).
 *
 * The gate asserts SET EQUALITY between the overlays it discovers in source and
 * the scenario/exclusion tables in `mobile-overflow.spec.ts`. That makes the
 * discovery step the load-bearing half: an overlay the discovery misses is
 * absent from BOTH sides of that equality, so the assertion still passes and the
 * overlay is simply never measured — a silent green instead of a loud red.
 *
 * Discovery therefore never matches literal JSX identifiers. It resolves the
 * imports of every candidate component back to the files that OWN the overlay
 * primitives, so `import { ODialog as Sheet }` and a primitive renamed or newly
 * added inside a registered primitive source are both found. A primitive that
 * appears somewhere the resolver does not look fails the registry check below
 * with a named error instead of quietly discovering nothing.
 */

/** Product components scanned for overlay usage. */
export const USER_OVERLAY_SOURCE_ROOT = 'apps/web/src/user';

/**
 * The shared UI layer. Everything here is infrastructure, so a portal-rendering
 * component that appears in this tree without being registered below is a new
 * overlay primitive whose consumers would go undiscovered — that is a named
 * failure, not a silent one.
 */
export const SHARED_UI_SOURCE_ROOT = 'apps/web/src/ui';

/**
 * Overlay infrastructure: files whose exported components ARE the shared
 * overlay primitives rather than product content that opens one. Their own JSX
 * is never a measured surface; every consumer that renders one of their exports
 * is discovered instead, under whatever local name it imports it as.
 *
 * A NEW primitive inside one of these files needs no edit here — it is derived
 * from the source. A new primitive file under {@link SHARED_UI_SOURCE_ROOT}
 * must be added here; a new portal-rendering component under
 * {@link USER_OVERLAY_SOURCE_ROOT} is already discovered as a surface in its own
 * right, and only belongs here if it is genuinely shared infrastructure.
 */
export const OVERLAY_PRIMITIVE_SOURCES = [
  'apps/web/src/user/components/Dialog.tsx',
  'apps/web/src/ui/origin/components.tsx',
] as const;

/**
 * The primitives whose disappearance from every registered source must fail
 * loudly. `ODialog`/`Drawer` live outside the user tree, so before #1663 the
 * gate discovered their consumers only by matching those two literal tag names;
 * this asserts the relationship instead of assuming it.
 */
export const REQUIRED_OVERLAY_PRIMITIVES = ['Dialog', 'ODialog', 'Drawer'] as const;

/** Popover class the shell-owned menus are painted with. */
const POPOVER_CLASS_TOKEN = /(^|[^\w-])bt-popover([^\w-]|$)/;

/** Reads a repo-relative source file, or returns undefined if it does not exist. */
export type SourceReader = (relativePath: string) => string | undefined;

/** Lists the source files (excluding tests) under a repo-relative directory. */
export type SourceLister = (relativeDirectory: string) => string[];

export interface OverlayDetection {
  reader: SourceReader;
  list: SourceLister;
  primitiveSources: ReadonlySet<string>;
  userRoot: string;
  uiRoot: string;
  requiredPrimitives: readonly string[];
}

const diskReader: SourceReader = (relativePath) => {
  try {
    return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
  } catch {
    return undefined;
  }
};

const diskLister: SourceLister = (relativeDirectory) =>
  readdirSync(resolve(process.cwd(), relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) return diskLister(path);
      return entry.isFile() && path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
    },
  );

/** The real repo-backed detection context used by the gate. */
export function repoOverlayDetection(): OverlayDetection {
  return {
    reader: diskReader,
    list: diskLister,
    primitiveSources: new Set(OVERLAY_PRIMITIVE_SOURCES),
    userRoot: USER_OVERLAY_SOURCE_ROOT,
    uiRoot: SHARED_UI_SOURCE_ROOT,
    requiredPrimitives: REQUIRED_OVERLAY_PRIMITIVES,
  };
}

/**
 * A detection context over in-memory sources, used by the spec's fixture proof
 * that discovery survives aliasing and renamed primitives.
 */
export function virtualOverlayDetection(
  files: Readonly<Record<string, string>>,
  overrides: Partial<Omit<OverlayDetection, 'reader' | 'list'>> = {},
): OverlayDetection {
  const paths = Object.keys(files);
  return {
    reader: (relativePath) => files[relativePath],
    list: (relativeDirectory) =>
      paths.filter(
        (path) =>
          path.startsWith(`${relativeDirectory}/`) &&
          path.endsWith('.tsx') &&
          !path.endsWith('.test.tsx'),
      ),
    primitiveSources: new Set(OVERLAY_PRIMITIVE_SOURCES),
    userRoot: USER_OVERLAY_SOURCE_ROOT,
    uiRoot: SHARED_UI_SOURCE_ROOT,
    requiredPrimitives: REQUIRED_OVERLAY_PRIMITIVES,
    ...overrides,
  };
}

function parseSource(relativePath: string, reader: SourceReader): ts.SourceFile | undefined {
  const text = reader(relativePath);
  if (text === undefined) return undefined;
  return ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    // A plain `.ts` module must not be parsed as TSX: there, `<T>(x) => x` reads
    // as JSX and silently truncates the declarations after it.
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isCreatePortalCall(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression.getText(sourceFile);
  return callee === 'createPortal' || callee.endsWith('.createPortal');
}

function jsxAttributeText(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  sourceFile: ts.SourceFile,
): string | undefined {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
  );
  return attribute?.getText(sourceFile);
}

/**
 * Whether a component builds an overlay itself: it portals, or it paints modal
 * markup in place. `Drawer` is the reason the second half exists — it renders an
 * `aria-modal` `role="dialog"` aside without a portal, so a portal-only
 * definition of "primitive" would miss it and, with it, every consumer.
 */
function buildsOverlay(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (isCreatePortalCall(child, sourceFile)) {
      found = true;
      return;
    }
    const opening = ts.isJsxElement(child)
      ? child.openingElement
      : ts.isJsxSelfClosingElement(child)
        ? child
        : undefined;
    if (opening) {
      const modal = jsxAttributeText(opening, 'aria-modal', sourceFile);
      const role = jsxAttributeText(opening, 'role', sourceFile);
      if (modal?.includes('true') || role?.includes('"dialog"')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * The exported components of a file that BUILD an overlay — i.e. the overlay
 * primitives that file owns. Derived from the source, so a primitive that is
 * renamed or added inside a registered source is picked up without editing any
 * list.
 */
export function overlayPrimitiveExports(
  relativePath: string,
  detection: OverlayDetection,
): string[] {
  const sourceFile = parseSource(relativePath, detection.reader);
  if (!sourceFile) return [];

  const portalLocals = new Set<string>();
  const exportedNames = new Set<string>();
  const locallyExported = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (buildsOverlay(statement, sourceFile)) portalLocals.add(statement.name.text);
      if (isExported(statement)) exportedNames.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (buildsOverlay(declaration.initializer, sourceFile)) {
          portalLocals.add(declaration.name.text);
        }
        if (isExported(statement)) exportedNames.add(declaration.name.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      // `export { Dialog }` after the declaration counts the same as an inline
      // `export function Dialog`.
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        locallyExported.add((element.propertyName ?? element.name).text);
      }
    }
  }

  return [...portalLocals].filter((name) => exportedNames.has(name) || locallyExported.has(name));
}

/** Resolve a relative import/export specifier to a repo-relative source path. */
function resolveModule(
  fromRelativePath: string,
  specifier: string,
  reader: SourceReader,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = join(dirname(fromRelativePath), specifier);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (reader(candidate) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The overlay primitives a module exposes, following re-export barrels.
 *
 * Consumers import `ODialog` from `../../ui/origin` (a barrel), not from the
 * file that defines it, so resolution has to walk `export { … } from './…'`
 * chains — including renames — before it can say whether an imported name is a
 * primitive.
 */
function primitiveExportsOf(
  relativePath: string,
  detection: OverlayDetection,
  seen: Set<string> = new Set(),
): Map<string, string> {
  const exports = new Map<string, string>();
  if (seen.has(relativePath)) return exports;
  seen.add(relativePath);

  if (detection.primitiveSources.has(relativePath)) {
    for (const name of overlayPrimitiveExports(relativePath, detection)) {
      exports.set(name, relativePath);
    }
    return exports;
  }

  const sourceFile = parseSource(relativePath, detection.reader);
  if (!sourceFile) return exports;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveModule(relativePath, statement.moduleSpecifier.text, detection.reader);
    if (!target) continue;
    const reachable = primitiveExportsOf(target, detection, seen);
    if (reachable.size === 0) continue;
    const clause = statement.exportClause;
    if (clause === undefined) {
      for (const [name, source] of reachable) exports.set(name, source);
    } else if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const source = reachable.get((element.propertyName ?? element.name).text);
        if (source) exports.set(element.name.text, source);
      }
    }
  }
  return exports;
}

interface OverlayBindings {
  /** Local JSX names bound to an overlay primitive, including aliases. */
  components: Set<string>;
  /** `import * as x` namespaces whose primitive export names are the values. */
  namespaces: Map<string, Set<string>>;
}

function overlayBindings(sourceFile: ts.SourceFile, detection: OverlayDetection): OverlayBindings {
  const components = new Set<string>();
  const namespaces = new Map<string, Set<string>>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }
    const target = resolveModule(
      sourceFile.fileName,
      statement.moduleSpecifier.text,
      detection.reader,
    );
    if (!target) continue;
    const reachable = primitiveExportsOf(target, detection);
    if (reachable.size === 0) continue;

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        if (reachable.has((element.propertyName ?? element.name).text)) {
          components.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, new Set(reachable.keys()));
    }
  }

  return { components, namespaces };
}

/**
 * Whether a product component renders an overlay: a resolved overlay primitive
 * (under any local name), an overlay it builds itself (a portal or in-place
 * modal markup), or a `bt-popover` it paints — including one composed through a
 * local class constant.
 */
export function rendersOverlay(relativePath: string, detection: OverlayDetection): boolean {
  const sourceFile = parseSource(relativePath, detection.reader);
  if (!sourceFile) return false;
  const bindings = overlayBindings(sourceFile, detection);

  // A class constant is only a popover if it is USED as a className. AskDock
  // keeps `.bt-popover` in a querySelector string, which paints nothing.
  const popoverConstants = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (POPOVER_CLASS_TOKEN.test(declaration.initializer.getText(sourceFile))) {
        popoverConstants.add(declaration.name.text);
      }
    }
  }

  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    // A component that portals or paints its own `aria-modal`/`role="dialog"`
    // markup is an overlay even when it imports no primitive at all.
    if (isCreatePortalCall(node, sourceFile)) {
      found = true;
      return;
    }
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening) {
      const tag = opening.tagName.getText(sourceFile);
      const [namespace, member] = tag.split('.');
      if (
        bindings.components.has(tag) ||
        (member !== undefined && (bindings.namespaces.get(namespace!)?.has(member) ?? false))
      ) {
        found = true;
        return;
      }
      const modal = jsxAttributeText(opening, 'aria-modal', sourceFile);
      const role = jsxAttributeText(opening, 'role', sourceFile);
      if (modal?.includes('true') || role?.includes('"dialog"')) {
        found = true;
        return;
      }
      const className = opening.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'className',
      );
      if (className) {
        const text = className.getText(sourceFile);
        if (
          POPOVER_CLASS_TOKEN.test(text) ||
          [...popoverConstants].some((name) =>
            new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(text),
          )
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every product component that renders an overlay. The gate requires each one
 * to carry a measured scenario or a component-and-route exclusion.
 */
export function overlaySurfaceSources(detection: OverlayDetection): string[] {
  return detection
    .list(detection.userRoot)
    .filter(
      (relativePath) =>
        !detection.primitiveSources.has(relativePath) && rendersOverlay(relativePath, detection),
    )
    .sort();
}

/**
 * Problems with the primitive registry itself, as human-readable lines. The
 * gate asserts this is empty: a primitive that moved out of every registered
 * source, or a new unregistered one in the shared UI layer, would otherwise
 * shrink discovery to nothing while the equality assertion stayed green.
 */
export function overlayPrimitiveRegistryProblems(detection: OverlayDetection): string[] {
  const problems: string[] = [];
  const found = new Map<string, string>();

  for (const source of detection.primitiveSources) {
    const exported = overlayPrimitiveExports(source, detection);
    if (exported.length === 0) {
      problems.push(
        `${source} is registered as overlay infrastructure but exports no overlay-building component; move the registration to the file that owns the primitive.`,
      );
      continue;
    }
    for (const name of exported) found.set(name, source);
  }

  for (const required of detection.requiredPrimitives) {
    if (!found.has(required)) {
      problems.push(
        `The overlay primitive <${required}> was not found in any registered source (${[
          ...detection.primitiveSources,
        ].join(', ')}); register the file it moved to in OVERLAY_PRIMITIVE_SOURCES.`,
      );
    }
  }

  for (const path of detection.list(detection.uiRoot)) {
    if (detection.primitiveSources.has(path)) continue;
    const exported = overlayPrimitiveExports(path, detection);
    if (exported.length > 0) {
      problems.push(
        `${path} exports the overlay primitive(s) ${exported
          .map((name) => `<${name}>`)
          .join(', ')}; register it in OVERLAY_PRIMITIVE_SOURCES so every consumer is discovered.`,
      );
    }
  }

  return problems;
}
