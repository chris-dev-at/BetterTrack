import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { canonicalAmount as expenseCanonicalAmount } from '../services/expenses/expenseImportService';
import { canonicalAmount as brokerCanonicalAmount } from '../services/imports/contentHash';

/**
 * Strict-separation regression (PROJECTPLAN.md §13.5 V5-P9 acceptance #2 /
 * done-when "portfolio surfaces are byte-identical with the feature unused").
 *
 * The guarantee is STRUCTURAL: the expense module imports nothing from the
 * portfolio / domain money-math / tax layers, so it *cannot* alter their
 * behaviour — the portfolio surfaces are byte-identical whether or not a user
 * ever records an expense. This file is the single home for that invariant.
 *
 * #1660 closed three holes in it:
 *
 *  1. THE SCANNED SET WAS A HAND-MAINTAINED LIST of five files that omitted
 *     `services/expenses/ruleEngine.ts` and every bank mapper under
 *     `services/imports/expenseBank/**`. Adding `services/currency/fx` to a
 *     mapper breached the wall with the suite still green. The set is now
 *     DISCOVERED BY WALKING the directories the feature owns, so a new mapper is
 *     scanned the moment it exists.
 *  2. THE CHECK WAS A SUBSTRING MATCH on the raw specifier, so `'/domain/'`
 *     missed `from '../../domain'` (no trailing slash) and every re-export
 *     barrel. Specifiers are now RESOLVED to files and matched against module
 *     roots, and the walk follows barrels and the shared import framework to the
 *     module that really gets loaded.
 *  3. `expenseImportService` keeps a LOCAL COPY of `canonicalAmount` precisely so
 *     it need not import `services/imports/contentHash` (which imports
 *     `domain/cashLedger`). Nothing held the copy to the original. The last
 *     describe here does.
 *
 * Why the reachability walk stops where it does: it follows expense-owned
 * modules, pure re-export barrels and `services/imports/**` — the shared import
 * framework that already hosts the money-math bridge. It deliberately does NOT
 * walk the generic HTTP plumbing (`errors`, `middleware/*`, `serializers`) every
 * router shares: a domain import there would be a fact about the plumbing rather
 * than about expense/portfolio separation, and a fence that reddens on an
 * unrelated edit is a fence that gets deleted.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..');

/** Directories the expense feature owns outright — every module under them is scanned. */
const EXPENSE_DIRS = ['services/expenses', 'services/imports/expenseBank'];

/** Expense-owned modules that live among non-expense siblings. */
const EXPENSE_MODULES = ['data/repositories/expenseRepository.ts', 'http/routes/expensesRoutes.ts'];

/**
 * Module roots the expense area may not reach. Matched on the RESOLVED file, so
 * `../../domain`, `../../domain/cashLedger` and `../../domain/index` are one
 * rule and a barrel cannot launder any of them.
 */
const FORBIDDEN_MODULE_ROOTS = [
  'domain', // pure money-math (holdings, backtest, tax, allocation, cashLedger)
  'services/tax',
  'services/portfolio',
  'services/currency',
  'services/backtest',
  'services/cash', // the fused successor ledger — portfolio money by another name
  'data/repositories/portfolioRepository',
  'data/repositories/transactionRepository',
  'data/repositories/cashMovementRepository',
  'data/repositories/cashSourceRepository',
  'data/repositories/taxRepository',
  'data/repositories/portfolioSnapshotRepository',
  // The broker content hash is the known bridge: it imports `domain/cashLedger`
  // for `floorCents`, which is exactly why `expenseImportService` carries its own
  // `canonicalAmount`. Importing it would pull the money math in sideways.
  'services/imports/contentHash',
];

/** Packages the expense area may not import — `@bettertrack/domain` is the money math. */
const FORBIDDEN_PACKAGE_ROOTS = ['@bettertrack/domain'];

/**
 * Raw-specifier fragments, kept from the original fence. Redundant with the
 * resolved-path rules for everything they used to catch, and retained because
 * they also catch a specifier the resolver cannot follow.
 */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  '/domain/',
  'services/tax',
  'services/portfolio',
  'services/currency',
  'services/backtest',
  'portfolioRepository',
  'transactionRepository',
  'cashMovementRepository',
  'cashSourceRepository',
  'taxRepository',
  'dividend',
  'portfolioSnapshot',
];

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Every `.ts` module under `dir`, excluding test files and `__tests__` trees. */
function walkModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkModules(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * The expense-owned API modules, discovered rather than listed. A FUNCTION, not
 * a frozen constant: the negative-space probe plants a module in one of these
 * directories and has to see the set grow, which is what "a new mapper is
 * scanned automatically" actually means.
 */
function discoverExpenseFiles(): string[] {
  return [
    ...EXPENSE_DIRS.flatMap((dir) => walkModules(join(API_SRC, dir))),
    ...EXPENSE_MODULES.map((rel) => join(API_SRC, rel)),
  ]
    .map((full) => toPosix(relative(API_SRC, full)))
    .sort();
}

const EXPENSE_FILES: string[] = discoverExpenseFiles();

const EXPENSE_FILE_SET = new Set(EXPENSE_FILES);

/**
 * Stand-in for an `import()` whose target is an expression rather than a
 * literal. Deliberately not a module-looking string: it must never fall through
 * `resolveSpecifier`’s `package` branch, which is exactly how it used to escape.
 */
const COMPUTED_SPECIFIER = '<computed import() target>';

interface Specifier {
  /** The literal text of the `from '…'` clause. */
  text: string;
  /** `import type …` / `export type …` — erased at compile time, so it loads nothing. */
  typeOnly: boolean;
}

/**
 * Module specifiers, read with the TypeScript parser rather than a regex: the
 * type-only flag decides whether an import loads a module at runtime, and no
 * regex separates `import type { X } from` from a `from '…'` inside a comment or
 * a string reliably enough to be a fence.
 */
function specifiersOf(rel: string): Specifier[] {
  const file = join(API_SRC, rel);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const out: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedTypeOnly =
        clause !== undefined &&
        clause.name === undefined &&
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      out.push({
        text: node.moduleSpecifier.text,
        typeOnly: clause !== undefined && (clause.isTypeOnly || namedTypeOnly),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push({ text: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0]!;
      // A computed `import()` target — `import(mod)` — cannot be read
      // statically. It is recorded under {@link COMPUTED_SPECIFIER}, which
      // {@link resolveSpecifier} maps to `unresolved` so the fence REFUSES it:
      // an edge it cannot read is not an edge it may pass. Skipping it silently
      // is a hole wide enough to drive `import(process.env.X ??
      // '../../../domain/cashLedger')` through.
      out.push({
        text: ts.isStringLiteral(argument) ? argument.text : COMPUTED_SPECIFIER,
        typeOnly: false,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

type Resolved =
  | { kind: 'internal'; rel: string }
  | { kind: 'package'; name: string }
  | { kind: 'unresolved' };

/** Resolve a specifier the way the bundler does: `./x` → `x.ts`, then `x/index.ts`. */
function resolveSpecifier(fromRel: string, specifier: string): Resolved {
  // FIRST, before any other branch: a computed target names no module the fence
  // can read, so it resolves to nothing and is refused rather than waved past
  // as if it were a package name.
  if (specifier === COMPUTED_SPECIFIER) return { kind: 'unresolved' };
  if (!specifier.startsWith('.')) return { kind: 'package', name: specifier };
  const base = resolve(dirname(join(API_SRC, fromRel)), specifier);
  // `.js` maps back to its `.ts` source: an explicit-extension relative import
  // is still a readable edge, and calling it unresolved would be a false red.
  const literal = base.replace(/\.(js|mjs|cjs)$/, '');
  for (const candidate of [`${base}.ts`, `${literal}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { kind: 'internal', rel: toPosix(relative(API_SRC, candidate)) };
    }
  }
  return { kind: 'unresolved' };
}

function underRoot(rel: string, root: string): boolean {
  return rel === `${root}.ts` || rel === `${root}/index.ts` || rel.startsWith(`${root}/`);
}

/** The forbidden root a resolved module sits under, or null. */
function forbiddenRootOf(resolved: Resolved): string | null {
  if (resolved.kind === 'internal') {
    return FORBIDDEN_MODULE_ROOTS.find((root) => underRoot(resolved.rel, root)) ?? null;
  }
  if (resolved.kind === 'package') {
    return (
      FORBIDDEN_PACKAGE_ROOTS.find(
        (root) => resolved.name === root || resolved.name.startsWith(`${root}/`),
      ) ?? null
    );
  }
  return null;
}

/** A module whose every non-import statement re-exports another module — a pure barrel. */
function isReExportBarrel(rel: string): boolean {
  const file = join(API_SRC, rel);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const statements = source.statements.filter((statement) => !ts.isImportDeclaration(statement));
  if (statements.length === 0) return false;
  return statements.every(
    (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
  );
}

/**
 * Follow a value import into `rel`? Expense-owned code, pure re-export barrels
 * (which launder anything) and the shared import framework — see the header for
 * why the generic HTTP plumbing is out.
 */
function walkInto(rel: string): boolean {
  return EXPENSE_FILE_SET.has(rel) || rel.startsWith('services/imports/') || isReExportBarrel(rel);
}

/**
 * Every wall breach in ONE module's own import list, as readable lines. Shared
 * by the per-file check and by the negative-space probe below, so the probe
 * exercises the fence itself rather than a second copy of its rules that could
 * quietly disagree with it.
 */
function directBreaches(rel: string): string[] {
  const breaches: string[] = [];
  for (const specifier of specifiersOf(rel)) {
    // Legacy raw-text rule (kept: it also catches what the resolver cannot).
    for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
      if (specifier.text.includes(fragment)) {
        breaches.push(
          `${rel} imports "${specifier.text}" which breaches the wall (contains "${fragment}")`,
        );
      }
    }
    // Resolved rule: catches `from '../../domain'` and every alias of it.
    const resolved = resolveSpecifier(rel, specifier.text);
    if (resolved.kind === 'unresolved') {
      breaches.push(
        `${rel} imports "${specifier.text}", which this fence cannot resolve to a module — ` +
          'resolve it or teach the fence, but do not let it pass unread',
      );
      continue;
    }
    const forbidden = forbiddenRootOf(resolved);
    if (forbidden !== null) {
      breaches.push(
        `${rel} imports "${specifier.text}" which resolves into the forbidden module root ` +
          `"${forbidden}"`,
      );
    }
  }
  return breaches;
}

describe('expense module — strict separation from portfolio money (AC #2)', () => {
  it('discovers the expense-owned modules instead of trusting a hand-written list', () => {
    // The walk replaces a five-entry list that silently omitted both of these.
    expect(EXPENSE_FILES).toContain('services/expenses/ruleEngine.ts');
    for (const mapper of ['erste-george', 'raiffeisen-elba', 'n26', 'revolut', 'registry']) {
      expect(EXPENSE_FILES).toContain(`services/imports/expenseBank/${mapper}.ts`);
    }
    // The five the old list did name are still in it.
    for (const kept of [
      'services/expenses/expenseService.ts',
      'services/expenses/expenseImportService.ts',
      'services/expenses/budgetService.ts',
      'data/repositories/expenseRepository.ts',
      'http/routes/expensesRoutes.ts',
    ]) {
      expect(EXPENSE_FILES).toContain(kept);
    }
    // A walk that returned nothing (or only tests) would make every `it.each`
    // below pass vacuously.
    expect(EXPENSE_FILES.length).toBeGreaterThanOrEqual(14);
    for (const rel of EXPENSE_FILES) {
      expect(rel, `${rel} is a test file, not a shipped module`).not.toMatch(
        /__tests__|\.test\.ts$/,
      );
      expect(existsSync(join(API_SRC, rel)), `${rel} exists`).toBe(true);
    }
  });

  it.each(EXPENSE_FILES)('%s imports nothing from portfolio/tax/domain', (rel) => {
    const breaches = directBreaches(rel);
    expect(breaches, breaches.join('\n')).toEqual([]);
  });

  it('cannot reach the money math through a barrel or the shared import framework', () => {
    interface Hop {
      rel: string;
      chain: readonly string[];
    }
    const seen = new Set<string>();
    const queue: Hop[] = EXPENSE_FILES.map((rel) => ({ rel, chain: [rel] }));
    const breaches: string[] = [];
    let hops = 0;

    while (queue.length > 0) {
      const { rel, chain } = queue.shift()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const specifier of specifiersOf(rel)) {
        // A type-only import is erased before the module ever loads, so it
        // cannot execute money math. The per-file rule above still forbids it.
        if (specifier.typeOnly) continue;
        const resolved = resolveSpecifier(rel, specifier.text);
        const forbidden = forbiddenRootOf(resolved);
        if (forbidden !== null) {
          breaches.push(`${[...chain, specifier.text].join(' -> ')}  (root "${forbidden}")`);
          continue;
        }
        // An edge the fence cannot read is not an edge it may pass: a computed
        // `import()` deeper in a barrel would otherwise reach the money math
        // with the walk reporting a clean graph.
        if (resolved.kind === 'unresolved') {
          breaches.push(
            `${[...chain, specifier.text].join(' -> ')}  (unreadable — the fence cannot resolve it)`,
          );
          continue;
        }
        if (resolved.kind !== 'internal' || !walkInto(resolved.rel)) continue;
        hops += 1;
        queue.push({ rel: resolved.rel, chain: [...chain, resolved.rel] });
      }
    }

    // Non-vacuity: the walk really traversed the graph rather than stalling at
    // the seeds (`expenseImportService` alone reaches the mapper barrel and the
    // shared CSV parser).
    expect(hops).toBeGreaterThan(5);
    expect(seen.size).toBeGreaterThan(EXPENSE_FILES.length);
    expect(breaches, breaches.join('\n')).toEqual([]);
  });

  /**
   * NEGATIVE SPACE. Every test above asserts the tree is clean, which a fence
   * that reads nothing also satisfies. This one plants a real breach in a real
   * module of the walked set and requires the fence to say so.
   *
   * The breach is the one that got through review: a COMPUTED `import()`.
   * `import(mod)` carries no literal for the parser to read, and the fence used
   * to record it as a pseudo-package specifier, which is neither a forbidden
   * root nor unresolved — so `const mod = process.env.X ?? '…/domain/cashLedger'`
   * loaded the money math with all 19 tests green.
   */
  it('reports a computed import() target rather than waving it through', () => {
    const rel = 'services/expenses/computedImportProbe.ts';
    const file = join(API_SRC, rel);
    // The exact shape that escaped: no literal specifier anywhere in the file,
    // so nothing here can be caught by reading strings.
    writeFileSync(
      file,
      "const mod = process.env.X ?? '../../../domain/cashLedger';\n" +
        'export const load = () => import(mod);\n',
      'utf8',
    );
    try {
      // Planting it in an owned directory is enough to be scanned — no list edit.
      expect(discoverExpenseFiles()).toContain(rel);

      const breaches = directBreaches(rel);
      expect(
        breaches.length,
        `expected the fence to refuse ${rel}, got: ${breaches.join(' | ')}`,
      ).toBeGreaterThan(0);
      const report = breaches.join('\n');
      expect(report).toContain('cannot resolve to a module');
      expect(report).toContain(COMPUTED_SPECIFIER);

      // And precision, not just recall: the SAME module with a literal target
      // resolves cleanly, so the rule refuses unreadable edges rather than every
      // `import()`.
      writeFileSync(file, "export const load = () => import('./ruleEngine');\n", 'utf8');
      expect(directBreaches(rel)).toEqual([]);
    } finally {
      rmSync(file, { force: true });
    }
    expect(existsSync(file), 'the probe module is removed again').toBe(false);
    expect(discoverExpenseFiles()).not.toContain(rel);
  });

  it('the expense repository only imports expense tables from the schema', () => {
    const source = readFileSync(join(API_SRC, 'data/repositories/expenseRepository.ts'), 'utf8');
    // Isolate the `import { … } from '../schema'` binding block.
    const match = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/schema['"]/);
    expect(match, 'expected a schema import in expenseRepository').toBeTruthy();
    const bindings = match![1]!
      .split(',')
      .map((b) => b.replace(/\btype\b/, '').trim())
      .filter(Boolean);
    expect(bindings.length).toBeGreaterThan(0);
    // Every schema binding is an expense table/type — so the repository provably
    // cannot query a portfolio/tax table (an unimported table can't be referenced).
    for (const binding of bindings) {
      expect(
        binding.toLowerCase().startsWith('expense'),
        `expenseRepository imports non-expense schema symbol "${binding}"`,
      ).toBe(true);
    }
  });
});

/**
 * The duplication the fence forces, pinned (#1660). `expenseImportService` keeps
 * its own `canonicalAmount` so it never imports `services/imports/contentHash`
 * (which imports `domain/cashLedger`). The copy is load-bearing — it renders the
 * amount slot of `expenseDedupHash`, the import idempotency key — so drift
 * between the two would change which bank rows count as already-imported while
 * every other test stayed green.
 *
 * The broker original takes the column scale as an argument; the expense copy is
 * fixed at 2 (`numeric(20,2)` cents), which is the scale it is held to here.
 */
describe('the local canonicalAmount copy stays equivalent to the shared one', () => {
  const SCALE = 2;

  const EDGE_VALUES = [
    0,
    -0,
    1,
    -1,
    5,
    5.0,
    5.004,
    5.005,
    -5.004,
    -5.005,
    0.001,
    -0.001,
    0.005,
    -0.005,
    0.1 + 0.2,
    1 / 3,
    1234.567,
    999999.994,
    999999.995,
    -999999.995,
    1e-9,
    -1e-9,
    1e15,
    -1e15,
    // `toFixed` switches to exponential notation from 1e21 up; both copies
    // inherit that quirk identically, and the test says so rather than avoiding it.
    1e21,
    -1e21,
    Number.EPSILON,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
  ];

  /** Deterministic sweep (seeded LCG) — a fixed corpus, never a flaky one. */
  function sweep(count: number): number[] {
    let state = 0x2f6f2b79;
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const unit = state / 0x100000000;
      const magnitude = 10 ** (Math.floor(unit * 12) - 4);
      out.push((i % 2 === 0 ? 1 : -1) * unit * magnitude);
    }
    return out;
  }

  it('renders every amount exactly as contentHash.canonicalAmount(value, 2) does', () => {
    const values = [...EDGE_VALUES, ...sweep(2000)];
    expect(values.length).toBeGreaterThan(2000);
    for (const value of values) {
      expect(expenseCanonicalAmount(value), `canonicalAmount(${value})`).toBe(
        brokerCanonicalAmount(value, SCALE),
      );
    }
  });

  it('actually renders — the equality above is not two empty strings', () => {
    // Guards the trivially-passing failure mode: both sides returning '' for
    // everything would satisfy the sweep without canonicalizing anything.
    expect(expenseCanonicalAmount(5)).toBe('5');
    expect(expenseCanonicalAmount(5.0)).toBe('5');
    expect(expenseCanonicalAmount(5.004)).toBe('5');
    expect(expenseCanonicalAmount(5.006)).toBe('5.01');
    expect(expenseCanonicalAmount(5.25)).toBe('5.25');
    // `-0.00` collapses to `0`, so a rounding-to-zero debit cannot hash
    // differently from a credit of the same magnitude.
    expect(expenseCanonicalAmount(-0.004)).toBe('0');
    expect(expenseCanonicalAmount(1234.5)).toBe('1234.5');
    // The binary-float edge both copies share: 5.005 is stored just under the
    // half, so it rounds DOWN. Pinned here so the shared quirk is a decision on
    // the record rather than a surprise the day someone "fixes" one copy.
    expect(expenseCanonicalAmount(5.005)).toBe('5');
    expect(brokerCanonicalAmount(5.005, SCALE)).toBe('5');
  });
});
