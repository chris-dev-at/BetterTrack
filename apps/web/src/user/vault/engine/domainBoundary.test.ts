import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENGINE_ROOT = resolve(process.cwd(), 'src/user/vault/engine');

interface ProductionSource {
  file: string;
  sourceFile: ts.SourceFile;
}

interface CallableReferences {
  identifiers: Set<string>;
  namespaceProperties: Set<string>;
}

const AUDITED_MONEY_PRIMITIVES = [
  'cashBalancesBySource',
  'netWorthSeries',
  'floorCents',
  'deriveHoldings',
  'reducePosition',
  'valueOverTime',
  'costBasisOverTime',
  'timeWeightedReturn',
  'computeSeriesStats',
  'settleAtYear',
  'settleDeYear',
  'deCarryPots',
  'dePotCategoryForAssetType',
] as const;

const MONEY_IDENTIFIER =
  /(eur|amount|value|price|cost|basis|gain|loss|tax|cash|balance|pnl|dividend|invested|kapest|soli|pot|fee|quantity|held|allowance|rate|fx|twr|pct|percent)/i;

/**
 * Pre-E6 arithmetic that remains in the v1 client engine. Each AST signature
 * pins its owner, operator, money-bearing references and maximum occurrence
 * count. A renamed helper, new operator or additional occurrence is denied.
 * Removing an entry from production is allowed and should shrink this baseline.
 */
const LEGACY_MONEY_ARITHMETIC_BASELINE = new Map<string, number>([
  ['clientSeries.ts::trimZeroValueEdges::+::@trimZeroValueEdges', 1],
  ['clientSeries.ts::trimZeroValueEdges::+=::@trimZeroValueEdges', 1],
  ['clientSeries.ts::trimZeroValueEdges::-::@trimZeroValueEdges', 1],
  ['clientSeries.ts::trimZeroValueEdges::-=::@trimZeroValueEdges', 1],
  ['manualAsset.ts::interpolateDailyPrices::*::@interpolateDailyPrices', 2],
  ['manualAsset.ts::interpolateDailyPrices::+::@interpolateDailyPrices', 3],
  ['manualAsset.ts::interpolateDailyPrices::+=::@interpolateDailyPrices', 2],
  ['manualAsset.ts::interpolateDailyPrices::-::@interpolateDailyPrices', 4],
  ['manualAsset.ts::interpolateDailyPrices::/::@interpolateDailyPrices', 2],
  ['paranoidPortfolioStore.ts::portfolioResponse::*::dayChangeEur,dayPrevValueEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::*::investedEur,unrealizedPnlEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::+::cashBalanceEur,marketValueEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::+::costBasisEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::+=::dayChangeEur', 1],
  [
    'paranoidPortfolioStore.ts::portfolioResponse::+=::dayChangeEur,dayPrevValueEur,marketValueEur',
    1,
  ],
  ['paranoidPortfolioStore.ts::portfolioResponse::-::dayChangeEur,marketValueEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::-::investedEur,marketValueEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::/::dayChangeEur,dayPrevValueEur', 1],
  ['paranoidPortfolioStore.ts::portfolioResponse::/::investedEur,unrealizedPnlEur', 1],
  ['portfolioEngine.ts::derive::*::holdingsValueEur,marketValueEur', 1],
  ['portfolioEngine.ts::derive::+::balance', 1],
  ['portfolioEngine.ts::derive::+::cashBalanceEur,holdingsValueEur', 1],
  ['portfolioEngine.ts::derive::+::marketValueEur', 1],
  ['portfolioEngine.ts::derive::-::costBasis,holdingValue', 1],
  ['portfolioEngine.ts::derive::/::holdingsValueEur,marketValueEur', 1],
  ['portfolioEngine.ts::splitCashBuyFlows::unary-::amountEur', 1],
  ['portfolioEngine.ts::toBase::*::amount,value', 1],
  ['session.ts::persistedTaxDecimal::**::@persistedTaxDecimal', 1],
  ['session.ts::persistedTaxDecimal::*::@persistedTaxDecimal', 1],
  ['session.ts::persistedTaxDecimal::-::@persistedTaxDecimal', 2],
  ['session.ts::persistedTaxDecimal::unary-::@persistedTaxDecimal', 1],
  ['session.ts::validatePersistedTaxSettings::**::@validatePersistedTaxSettings', 1],
  ['session.ts::validatePersistedTaxSettings::*::@validatePersistedTaxSettings', 1],
  ['taxEngine.ts::addTarget::+::value', 1],
  ['taxEngine.ts::buildTaxReport::+::@buildTaxReport', 1],
  ['taxEngine.ts::buildTaxReport::-::@buildTaxReport', 4],
  ['taxEngine.ts::clientTaxYears::-::@clientTaxYears', 1],
  ['taxEngine.ts::effectiveTaxSettings::unary-::@effectiveTaxSettings', 1],
  ['taxEngine.ts::positionsForYear::+::dividendRows,taxAmountEur', 1],
  ['taxEngine.ts::positionsForYear::+::grossAmountEur', 1],
  ['taxEngine.ts::positionsForYear::+::realizedPnlEur', 1],
  ['taxEngine.ts::positionsForYear::+::taxAmountEur', 2],
  ['taxEngine.ts::summaryForYear::+::automaticTargetEur,manualTax', 1],
  ['taxEngine.ts::summaryForYear::+::grossAmountEur', 1],
  ['taxEngine.ts::summaryForYear::+::realizedPnlEur', 1],
  ['taxEngine.ts::summaryForYear::+::taxAmountEur', 2],
  ['taxEngine.ts::summaryForYear::+::taxAmountEur,yearDividends', 1],
  ['taxEngine.ts::summaryForYear::+=::amountEur,taxRefundedEur', 1],
  ['taxEngine.ts::summaryForYear::+=::amountEur,taxWithheldEur', 1],
  ['taxEngine.ts::summaryForYear::-::taxRefundedEur,taxWithheldEur', 1],
  ['taxEngine.ts::summaryForYear::unary-::amountEur', 1],
  ['taxEngine.ts::taxableTransactions::*::fee,fx,value', 1],
  ['taxEngine.ts::taxableTransactions::*::fx,price,value', 1],
  ['taxEngine.ts::taxableTransactions::*::fx,uncoveredEntryPrice,value', 1],
  ['taxEngine.ts::taxableTransactions::-::@taxableTransactions', 1],
]);

/** §14 permits only these two already-reviewed additive composition seams. */
const COMPOSITION_ARITHMETIC_ALLOWLIST = new Map<string, number>([
  ['composition.ts::composeCountryTaxYear::+::amountEur', 2],
  ['composition.ts::composeCountryTaxYear::-::@composeCountryTaxYear', 3],
  ['composition.ts::composeCountryTaxYear::unary-::@composeCountryTaxYear', 2],
  ['composition.ts::composePortfolioFigures::+::value', 1],
]);

const productionSources = readProductionSources(ENGINE_ROOT);

describe('E6 shared-domain money boundary', () => {
  it('keeps valuation, holdings, series and tax on audited domain imports', () => {
    expect(importedNames('portfolioEngine.ts', '@bettertrack/domain/cashLedger')).toEqual(
      expect.arrayContaining(['cashBalancesBySource', 'netWorthSeries']),
    );
    expect(importedNames('portfolioEngine.ts', '@bettertrack/domain/holdings')).toEqual(
      expect.arrayContaining(['deriveHoldings', 'reducePosition']),
    );
    expect(importedNames('portfolioEngine.ts', '@bettertrack/domain/seriesStats')).toContain(
      'computeSeriesStats',
    );
    expect(importedNames('taxEngine.ts', '@bettertrack/domain/tax')).toEqual(
      expect.arrayContaining(['settleAtYear', 'settleDeYear']),
    );
    expect(importedNames('composition.ts', '@bettertrack/domain/tax')).toEqual(
      expect.arrayContaining(['settleAtYear', 'settleDeYear']),
    );
  });

  it('does not define audited money arithmetic anywhere under engine', () => {
    // Discover production sources instead of maintaining a short hand-picked
    // list. A new engine module is therefore inside this boundary by default.
    expect(productionSources.length).toBeGreaterThanOrEqual(14);
    expect(productionSources.map(({ file }) => file)).toContain('VaultMoneyEngineProvider.tsx');

    const definitions = productionSources.flatMap(localAuditedDefinitions);
    expect(definitions).toEqual([]);

    const approved = new Map([
      ...LEGACY_MONEY_ARITHMETIC_BASELINE,
      ...COMPOSITION_ARITHMETIC_ALLOWLIST,
    ]);
    expect(unapprovedMoneyArithmetic(productionSources, approved)).toEqual([]);

    for (const input of productionSources) {
      expect(input.sourceFile.text, input.file).not.toContain('apps/api/src/domain');
    }
  });

  it('detects locally renamed money arithmetic with generic operands', () => {
    const canary = parseProductionSource(
      'renamed-local-money.ts',
      `function calculateTax(a: number, b: number) {
        let result = a - b;
        result += a;
        result = -result;
        result++;
        return result;
      }`,
    );

    expect(unapprovedMoneyArithmetic([canary], new Map())).toEqual([
      'renamed-local-money.ts::calculateTax::+=::@calculateTax',
      'renamed-local-money.ts::calculateTax::-::@calculateTax',
      'renamed-local-money.ts::calculateTax::postfix++::@calculateTax',
      'renamed-local-money.ts::calculateTax::unary-::@calculateTax',
    ]);
  });

  it('never feeds report-quantized money into an audited settlement', () => {
    // floorCents is valid when projecting a reported figure. It is not valid on
    // a settlement input: carried sub-cent DE pots are authoritative raw state.
    // Follow local bindings so both `settleDeYear({ pot: floorCents(raw) })`
    // and `const displayed = floorCents(raw); settleDeYear({ pot: displayed })`
    // fail. This is the exact data-flow shape behind review blocker 1.
    expect(productionSources.flatMap(quantizedSettlementInputs)).toEqual([]);
  });

  it('detects the reviewed carried-loss pre-floor pattern', () => {
    const reviewedDefect = parseProductionSource(
      'reviewed-defect.ts',
      `
        const aktienPotInEur = floorCents(pots.aktienEur);
        settleDeYear({ aktienPotInEur, sonstigePotInEur: pots.sonstigeEur });
      `,
    );

    expect(quantizedSettlementInputs(reviewedDefect)).toEqual([
      'reviewed-defect.ts: settleDeYear receives report-quantized money',
    ]);
  });

  it('follows aliases of audited quantization and settlement imports', () => {
    const aliasedDefect = parseProductionSource(
      'aliased-defect.ts',
      `
        import {
          floorCents as reportCents,
          settleDeYear as settleYear,
        } from '@bettertrack/domain/tax';
        const carried = reportCents(pots.aktienEur);
        settleYear({ aktienPotInEur: carried, sonstigePotInEur: pots.sonstigeEur });
      `,
    );

    expect(quantizedSettlementInputs(aliasedDefect)).toEqual([
      'aliased-defect.ts: settleYear receives report-quantized money',
    ]);
  });

  it('follows namespace imports of audited quantization and settlement calls', () => {
    const namespaceDefect = parseProductionSource(
      'namespace-defect.ts',
      `
        import * as cash from '@bettertrack/domain/cashLedger';
        import * as tax from '@bettertrack/domain/tax';
        const carried = cash.floorCents(pots.aktienEur);
        tax.settleDeYear({ aktienPotInEur: carried, sonstigePotInEur: pots.sonstigeEur });
      `,
    );

    expect(quantizedSettlementInputs(namespaceDefect)).toEqual([
      'namespace-defect.ts: tax.settleDeYear receives report-quantized money',
    ]);
  });

  it('follows local quantizer wrappers and later assignments', () => {
    const helperDefect = parseProductionSource(
      'helper-defect.ts',
      `
        function reported(value: number) { return floorCents(value); }
        let carried = pots.aktienEur;
        carried = reported(carried);
        settleDeYear({ aktienPotInEur: carried, sonstigePotInEur: pots.sonstigeEur });
      `,
    );

    expect(quantizedSettlementInputs(helperDefect)).toEqual([
      'helper-defect.ts: settleDeYear receives report-quantized money',
    ]);
  });

  it('keeps statutory rates out of every engine module and percentage arithmetic out of composition', () => {
    for (const input of productionSources) {
      expect(input.sourceFile.text, input.file).not.toMatch(
        /\b(?:0\.275|0\.25|0\.055|1000|2000)\b/,
      );
    }
    const composition = productionSources.find((input) => input.file === 'composition.ts');
    expect(composition).toBeDefined();
    expect(composition!.sourceFile.text).not.toMatch(/(?:valueEur|amountEur)\s*[*/]/);
    expect(composition!.sourceFile.text).not.toMatch(/[*/]\s*(?:valueEur|amountEur)/);
  });
});

function readProductionSources(directory: string): ProductionSource[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): ProductionSource[] => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readProductionSources(path);
      if (
        !entry.isFile() ||
        (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test.tsx') ||
        entry.name.endsWith('.testSupport.ts') ||
        entry.name.endsWith('.d.ts')
      ) {
        return [];
      }
      return [parseProductionSource(relative(ENGINE_ROOT, path), readFileSync(path, 'utf8'))];
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

function parseProductionSource(file: string, text: string): ProductionSource {
  return {
    file,
    sourceFile: ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

function importedNames(file: string, moduleName: string): string[] {
  const input = productionSources.find((candidate) => candidate.file === file);
  if (input == null) throw new Error(`Missing production engine source: ${file}`);

  return input.sourceFile.statements.flatMap((statement): string[] => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      return [];
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings == null || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
  });
}

function localAuditedDefinitions(input: ProductionSource): string[] {
  const audited = new Set<string>(AUDITED_MONEY_PRIMITIVES);
  const failures: string[] = [];

  visit(input.sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name != null && audited.has(node.name.text)) {
        failures.push(`${input.file}: defines audited primitive ${node.name.text}`);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) {
        if (audited.has(name)) failures.push(`${input.file}: defines audited primitive ${name}`);
      }
    }
  });
  return failures;
}

function unapprovedMoneyArithmetic(
  inputs: readonly ProductionSource[],
  approved: ReadonlyMap<string, number>,
): string[] {
  const actual = new Map<string, number>();
  for (const input of inputs) {
    visitMoneyArithmetic(input, input.sourceFile, null, actual);
  }

  return [...actual]
    .filter(([signature, count]) => count > (approved.get(signature) ?? 0))
    .map(([signature]) => signature)
    .sort();
}

function visitMoneyArithmetic(
  input: ProductionSource,
  node: ts.Node,
  owner: string | null,
  actual: Map<string, number>,
): void {
  const nextOwner = functionOwner(node, input.sourceFile) ?? owner;
  if (ts.isBinaryExpression(node) && isArithmeticOperator(node.operatorToken.kind)) {
    recordMoneyArithmetic(
      input,
      node,
      nextOwner,
      node.operatorToken.getText(input.sourceFile),
      actual,
    );
  } else if (ts.isPrefixUnaryExpression(node) && isUnaryArithmeticOperator(node.operator)) {
    recordMoneyArithmetic(
      input,
      node,
      nextOwner,
      `unary${ts.tokenToString(node.operator) ?? node.operator}`,
      actual,
    );
  } else if (ts.isPostfixUnaryExpression(node) && isUpdateOperator(node.operator)) {
    recordMoneyArithmetic(
      input,
      node,
      nextOwner,
      `postfix${ts.tokenToString(node.operator) ?? node.operator}`,
      actual,
    );
  }
  node.forEachChild((child) => visitMoneyArithmetic(input, child, nextOwner, actual));
}

function recordMoneyArithmetic(
  input: ProductionSource,
  node: ts.Node,
  owner: string | null,
  operator: string,
  actual: Map<string, number>,
): void {
  const references = moneyReferences(node, owner);
  if (references.length === 0) return;
  const signature = `${input.file}::${owner ?? '<module>'}::${operator}::${references.join(',')}`;
  actual.set(signature, (actual.get(signature) ?? 0) + 1);
}

function functionOwner(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sourceFile) ?? '<anonymous>';
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return node.parent.name.getText(sourceFile);
  }
  return null;
}

function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.PlusToken ||
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken
  );
}

function isUnaryArithmeticOperator(kind: ts.PrefixUnaryOperator): boolean {
  return (
    kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.MinusToken || isUpdateOperator(kind)
  );
}

function isUpdateOperator(kind: ts.PostfixUnaryOperator | ts.PrefixUnaryOperator): boolean {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
}

function moneyReferences(node: ts.Node, owner: string | null): string[] {
  const names = new Set<string>();
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && MONEY_IDENTIFIER.test(candidate.text)) {
      names.add(candidate.text);
    }
  });
  // Generic operands do not make a helper safe when its owning function is
  // explicitly money-bearing. This catches `calculateTax(a, b) { return a-b }`
  // without treating every date/index expression in the engine as money math.
  if (names.size === 0 && owner != null && MONEY_IDENTIFIER.test(owner)) {
    names.add(`@${owner}`);
  }
  return [...names].sort();
}

function quantizedSettlementInputs(input: ProductionSource): string[] {
  const quantizers = importedCallableReferences(input, 'floorCents');
  const settlements = mergeCallableReferences(
    importedCallableReferences(input, 'settleAtYear'),
    importedCallableReferences(input, 'settleDeYear'),
  );
  const quantizedBindings = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: Array<{ name: string; value: ts.Expression }> = [];
  const helpers: Array<{ name: string; body: ts.Node }> = [];
  visit(input.sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push({ name: node.left.text, value: node.right });
    }
    if (ts.isFunctionDeclaration(node) && node.name != null && node.body != null) {
      helpers.push({ name: node.name.text, body: node.body });
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer != null &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      helpers.push({ name: node.name.text, body: node.initializer.body });
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const helper of helpers) {
      if (
        (containsCall(helper.body, quantizers) ||
          containsAnyIdentifier(helper.body, quantizedBindings)) &&
        !quantizers.identifiers.has(helper.name)
      ) {
        quantizers.identifiers.add(helper.name);
        changed = true;
      }
    }
    for (const declaration of declarations) {
      if (
        declaration.initializer != null &&
        (containsCall(declaration.initializer, quantizers) ||
          containsAnyIdentifier(declaration.initializer, quantizedBindings))
      ) {
        for (const name of bindingNames(declaration.name)) {
          if (!quantizedBindings.has(name)) {
            quantizedBindings.add(name);
            changed = true;
          }
        }
      }
    }
    for (const assignment of assignments) {
      if (
        (containsCall(assignment.value, quantizers) ||
          containsAnyIdentifier(assignment.value, quantizedBindings)) &&
        !quantizedBindings.has(assignment.name)
      ) {
        quantizedBindings.add(assignment.name);
        changed = true;
      }
    }
  }

  const failures: string[] = [];
  visit(input.sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      isCallTo(node, settlements) &&
      node.arguments.some(
        (argument) =>
          containsCall(argument, quantizers) || containsAnyIdentifier(argument, quantizedBindings),
      )
    ) {
      failures.push(
        `${input.file}: ${node.expression.getText(input.sourceFile)} receives report-quantized money`,
      );
    }
  });
  return failures;
}

function importedCallableReferences(
  input: ProductionSource,
  exportedName: string,
): CallableReferences {
  // Keep the canonical spelling so focused synthetic snippets without imports
  // exercise the same detector. Real imports add their local alias below.
  const references: CallableReferences = {
    identifiers: new Set([exportedName]),
    namespaceProperties: new Set(),
  };
  for (const statement of input.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('@bettertrack/domain/')
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings == null) continue;
    if (ts.isNamespaceImport(bindings)) {
      references.namespaceProperties.add(`${bindings.name.text}.${exportedName}`);
    } else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === exportedName) {
          references.identifiers.add(element.name.text);
        }
      }
    }
  }
  return references;
}

function mergeCallableReferences(...references: readonly CallableReferences[]): CallableReferences {
  return {
    identifiers: new Set(references.flatMap((entry) => [...entry.identifiers])),
    namespaceProperties: new Set(references.flatMap((entry) => [...entry.namespaceProperties])),
  };
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function containsCall(node: ts.Node, references: CallableReferences): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && isCallTo(candidate, references)) {
      found = true;
    }
  });
  return found;
}

function isCallTo(call: ts.CallExpression, references: CallableReferences): boolean {
  if (ts.isIdentifier(call.expression)) {
    return references.identifiers.has(call.expression.text);
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression)
  ) {
    return references.namespaceProperties.has(
      `${call.expression.expression.text}.${call.expression.name.text}`,
    );
  }
  return false;
}

function containsAnyIdentifier(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (
      ts.isIdentifier(candidate) &&
      names.has(candidate.text) &&
      !isNonValueIdentifier(candidate)
    ) {
      found = true;
    }
  });
  return found;
}

function isNonValueIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === identifier) return true;
  return false;
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild((child) => visit(child, inspect));
}
