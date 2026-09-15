import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** The expense-owned API modules, discovered rather than listed. */
const EXPENSE_FILES: string[] = [
  ...EXPENSE_DIRS.flatMap((dir) => walkModules(join(API_SRC, dir))),
  ...EXPENSE_MODULES.map((rel) => join(API_SRC, rel)),
]
  .map((full) => toPosix(relative(API_SRC, full)))
  .sort();

const EXPENSE_FILE_SET = new Set(EXPENSE_FILES);

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
      // A computed `import()` target cannot be resolved statically, so it is
      // reported rather than skipped — an unreadable edge is not a clean one.
      out.push({
        text: ts.isStringLiteral(argument) ? argument.text : '<dynamic>',
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
  if (!specifier.startsWith('.')) return { kind: 'package', name: specifier };
  const base = resolve(dirname(join(API_SRC, fromRel)), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
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
    for (const specifier of specifiersOf(rel)) {
      // Legacy raw-text rule (kept: it also catches what the resolver cannot).
      for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
        expect(
          specifier.text.includes(fragment),
          `${rel} imports "${specifier.text}" which breaches the wall (contains "${fragment}")`,
        ).toBe(false);
      }
      // Resolved rule: catches `from '../../domain'` and every alias of it.
      const resolved = resolveSpecifier(rel, specifier.text);
      expect(
        resolved.kind === 'unresolved',
        `${rel} imports "${specifier.text}", which this fence cannot resolve to a module — ` +
          'resolve it or teach the fence, but do not let it pass unread',
      ).toBe(false);
      const forbidden = forbiddenRootOf(resolved);
      expect(
        forbidden,
        `${rel} imports "${specifier.text}" which resolves into the forbidden module root ` +
          `"${forbidden}"`,
      ).toBeNull();
    }
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
