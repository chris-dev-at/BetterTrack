import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './noDynamicSqlIdentifier.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const tsRuleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

/**
 * RuleTester registers the rule under `rule-to-test/<name>`, and ESLint's own
 * directive matching wants that exact id — a directive naming anything else
 * both fails to suppress AND raises "definition for rule was not found". The
 * directive cases below therefore spell the tester's id; the real
 * `sql/no-dynamic-identifier` id is exercised against `Linter` further down,
 * which is also what proves the rule's prefix-independent name matching.
 */
const TESTER_RULE_ID = 'rule-to-test/sql/no-dynamic-identifier';

test('no-dynamic-identifier requires a literal in every SQL identifier builder', () => {
  ruleTester.run('sql/no-dynamic-identifier', rule, {
    valid: [
      // The shapes the paranoid/vault review's claim rests on: spelled out.
      { code: "sql.identifier('conglomerate_positions');" },
      { code: 'sql.raw(`select 1`);' },
      { code: 'sql.raw("\'Europe/Vienna\'");' },
      { code: "alias(users, 'sender');" },
      { code: "db.select().from(t).as('newest_chat_message');" },
      // `alias()`'s FIRST argument is a table object, never a string — checking
      // the wrong index here would flag all seven real alias() call sites.
      { code: 'alias(users, `sender`);' },
      // Not SQL builders: express's body parser, and a zero-argument `.as()`
      // from some other library. Neither concatenates anything into a statement.
      { code: 'express.raw({ type: () => true, limit: max });' },
      { code: 'chain.as();' },
      { code: 'alias(users);' },
      // Documented limit: `raw`/`identifier` only bite on a receiver named
      // `sql`, because `express.raw` above must stay clean.
      { code: 'notSql.identifier(column);' },
      // The escape hatch, used the one way it may be used.
      {
        code: [
          `// eslint-disable-next-line ${TESTER_RULE_ID} -- LEGACY_DELETES is a module-level \`as const\` list`,
          'sql.raw(`"${table}"`);',
        ].join('\n'),
      },
    ],
    invalid: [
      {
        code: 'sql.identifier(column);',
        errors: [{ messageId: 'dynamic', line: 1, column: 5, endColumn: 15 }],
      },
      {
        code: 'sql.raw(`"${table}"`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'sql.raw(PARANOID_V1_WIPE_CANDIDATES_SQL);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "sql.raw(`'${CASH_MONTH_TIME_ZONE}'`);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'alias(users, name);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'aliasedTable(users, name);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'newest.as(name);',
        errors: [{ messageId: 'dynamic' }],
      },
      // Computed member access must not be a way around the rule.
      {
        code: "sql['identifier'](column);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "newest['as'](name);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Neither may a spread, nor a pair of literals behind a conditional.
      {
        code: 'sql.raw(...parts);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "sql.raw(flag ? 'a' : 'b');",
        errors: [{ messageId: 'dynamic' }],
      },
      // A multi-line chain is reported ON the `.as(` line, so the exemption
      // comment goes where a reader expects it.
      {
        code: ['const q = db', '  .select()', '  .from(t)', '  .as(name);'].join('\n'),
        errors: [{ messageId: 'dynamic', line: 4 }],
      },
      // Two builders, two findings.
      {
        code: 'sql`${sql.identifier(a)}.${sql.identifier(b)}`;',
        errors: [{ messageId: 'dynamic' }, { messageId: 'dynamic' }],
      },
      // An exemption without a stated reason IS the thing this gate exists to
      // stop: the call's own finding is suppressed, the directive's is not.
      {
        code: [`// eslint-disable-next-line ${TESTER_RULE_ID}`, 'sql.raw(table);'].join('\n'),
        errors: [{ messageId: 'missingReason', line: 1 }],
      },
      {
        // `-- ` with nothing after it is ESLint's own empty justification.
        code: [`// eslint-disable-next-line ${TESTER_RULE_ID} -- `, 'sql.raw(table);'].join('\n'),
        errors: [{ messageId: 'missingReason', line: 1 }],
      },
      // A blanket directive over a finding is reported even though it names no
      // rule — otherwise a bare `eslint-disable-next-line` swallows one silently.
      {
        code: ['// eslint-disable-next-line', 'sql.raw(table);'].join('\n'),
        errors: [{ messageId: 'blanketNextLine', line: 1 }],
      },
    ],
  });
});

test('no-dynamic-identifier judges TypeScript wrappers by what they wrap', () => {
  tsRuleTester.run('sql/no-dynamic-identifier', rule, {
    valid: [
      // `as const` / `satisfies` change the type and not one byte of the value.
      { code: "sql.raw('x' as const);" },
      { code: "sql.identifier('conglomerate_positions' satisfies string);" },
    ],
    invalid: [
      // A cast is not a provenance proof, and neither is `!`.
      {
        code: 'sql.raw(table as string);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'sql.raw(before!);',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });
});

const linter = new Linter();

/**
 * Lints under the rule's REAL id, the one `eslint.config.js` registers.
 * Unused-directive housekeeping is ESLint's own and off here, so every message
 * these assertions see comes from the rule under test.
 */
function lint(code) {
  return linter.verify(code, {
    plugins: { sql: { rules: { 'no-dynamic-identifier': rule } } },
    rules: { 'sql/no-dynamic-identifier': 'error' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
}

const summarise = (messages) => messages.map((m) => `${m.messageId ?? m.ruleId}@${m.line}`);

test('the escape hatch is policed under the real rule id', () => {
  // Prefix-independent matching: the rule knows `sql/no-dynamic-identifier` is
  // itself even though it never sees the plugin name it was registered under.
  assert.deepEqual(
    summarise(
      lint(
        [
          'const table = LEGACY_DELETES[0];',
          '// eslint-disable-next-line sql/no-dynamic-identifier -- LEGACY_DELETES is a module-level `as const` list',
          'sql.raw(`"${table}"`);',
        ].join('\n'),
      ),
    ),
    [],
  );

  // No reason → the exemption itself is the finding, on the comment's line.
  assert.deepEqual(
    summarise(
      lint(
        [
          'const table = LEGACY_DELETES[0];',
          '// eslint-disable-next-line sql/no-dynamic-identifier',
          'sql.raw(`"${table}"`);',
        ].join('\n'),
      ),
    ),
    ['missingReason@2'],
  );

  // The `-line` and block forms exempt more than one call. They also suppress a
  // diagnostic written on their own line, which is why theirs lands at line 1.
  assert.deepEqual(
    summarise(
      lint(
        [
          'const table = LEGACY_DELETES[0];',
          'sql.raw(`"${table}"`); // eslint-disable-line sql/no-dynamic-identifier -- closed list',
        ].join('\n'),
      ),
    ),
    ['wrongForm@1'],
  );

  assert.deepEqual(
    summarise(
      lint(
        [
          'const table = LEGACY_DELETES[0];',
          '/* eslint-disable sql/no-dynamic-identifier -- closed list */',
          'sql.raw(`"${table}"`);',
        ].join('\n'),
      ),
    ),
    ['wrongForm@1'],
  );

  // A file-wide blanket disable hides findings without naming anything.
  assert.deepEqual(
    summarise(
      lint(
        ['const table = LEGACY_DELETES[0];', '/* eslint-disable */', 'sql.raw(`"${table}"`);'].join(
          '\n',
        ),
      ),
    ),
    ['blanketWide@1'],
  );

  // A blanket disable with NO finding under it is none of this rule's business.
  assert.deepEqual(summarise(lint(['/* eslint-disable */', "sql.raw('literal');"].join('\n'))), []);

  // The documented residual hole, asserted rather than hoped about: a directive
  // written on line 1 suppresses the line-1 report about itself. Nothing a rule
  // can report escapes an inline config that covers the whole file.
  assert.deepEqual(summarise(lint('sql.raw(table); // eslint-disable-line')), []);
});
