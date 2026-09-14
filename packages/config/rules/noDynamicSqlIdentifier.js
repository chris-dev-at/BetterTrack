/**
 * `sql/no-dynamic-identifier` — the SQL-identifier reachability gate.
 *
 * Drizzle parameterises VALUES for us: an id interpolated into a `sql` tagged
 * template is sent as a bind parameter, so no value in one can change the shape
 * of the statement. IDENTIFIERS have no such protection — Postgres has no
 * placeholder for a table or column name — so `sql.identifier()`, `sql.raw()`,
 * drizzle's `alias()` and a subquery's `.as()` are the four places in this
 * codebase where a JavaScript string is concatenated into SQL text verbatim.
 *
 * The vault/paranoid review signed off on those call sites with a reachability
 * claim: *no user-controlled string ever reaches `sql.identifier` / `sql.raw` /
 * `alias()` / `.as()`*. That claim was true when it was made and nothing kept it
 * true — it holds only for as long as every one of those arguments is a literal,
 * which is a property of code nobody was checking. This rule is the check: an
 * argument that is not a string literal (or a template literal with no
 * expressions) fails `pnpm lint`, and therefore CI.
 *
 * ── The escape hatch, and why it is shaped like this ────────────────────────
 * A handful of real call sites legitimately pass a constant that is not spelled
 * at the call — a module-level `as const` table list, a statement string shared
 * byte-for-byte with an ops script. Those are exempted with
 *
 *     // eslint-disable-next-line sql/no-dynamic-identifier -- <why it is closed>
 *
 * and the rule polices the exemption itself, because an exemption without a
 * stated reason is how a reachability claim rots a second time:
 *
 *   * a directive naming this rule MUST be the `-next-line` form — the block and
 *     `-line` forms exempt more than the one call they were written for;
 *   * it MUST carry a `--` description, and the description is expected to name
 *     the closed allow-list the value comes from;
 *   * a blanket directive (no rule names) sitting over a violation is reported
 *     too, so a bare `// eslint-disable-next-line` can never quietly swallow one.
 *
 * Those directive diagnostics are reported at the comment for the `-next-line`
 * form (whose suppression window is the FOLLOWING line only, so the report
 * survives) and at the top of the file for the self-suppressing `-line` and
 * block forms, whose windows would otherwise cover the diagnostic about
 * themselves. The residual hole is a directive written on line 1 itself — a
 * block `/* eslint-disable … *\/` or an `eslint-disable-line` at the top of a
 * file suppresses even the line-1 report about itself. Nothing a rule can
 * report escapes an inline config covering its own diagnostic, the test suite
 * pins that limit rather than implying it away, and neither shape is subtle in
 * review.
 *
 * ── Deliberately NOT exempting tests ────────────────────────────────────────
 * Unlike the i18n and taxonomy gates, the glob in `eslint.config.js` includes
 * test sources. A test is where an unsafe "just interpolate the table name"
 * helper gets written first and copied into a repository second, and the few
 * real test sites (the account-deletion row counter, the migration replays) are
 * closed allow-lists that document themselves in one comment.
 *
 * ── Known limits, stated so nobody mistakes this for a proof ────────────────
 * `raw` and `identifier` are only matched on a receiver literally named `sql`
 * (the drizzle convention everywhere in this repo); `express.raw({…})` is a body
 * parser, not a SQL builder, and must not be flagged. Renaming the drizzle
 * import (`import { sql as q }`) therefore defeats the check — this is a lint,
 * not a type system. `.as()` is matched on any receiver, which is why the glob
 * stays on the drizzle-speaking trees (`apps/api`, `packages/*`, `e2e`).
 */

/** Member-call builders → the argument index that becomes SQL text verbatim. */
const MEMBER_BUILDERS = new Map([
  ['identifier', 0],
  ['raw', 0],
  ['as', 0],
]);

/** Bare-call builders (drizzle table aliasing) → same, `alias(table, name)`. */
const FREE_BUILDERS = new Map([
  ['alias', 1],
  ['aliasedTable', 1],
]);

/**
 * `raw`/`identifier` count only on the drizzle tag itself. Without this,
 * `express.raw({ type: … })` — a body parser — would be a SQL finding.
 */
const SQL_TAG_RECEIVERS = new Set(['sql']);

/** The string a node is, statically, or `null` if it is not a static string. */
function staticString(node) {
  const inner = unwrap(node);
  if (!inner) return null;
  if (inner.type === 'Literal' && typeof inner.value === 'string') return inner.value;
  if (inner.type === 'TemplateLiteral' && inner.expressions.length === 0) {
    return inner.quasis[0]?.value.cooked ?? '';
  }
  return null;
}

/**
 * Peels the TypeScript wrappers that change a value's TYPE and never its bytes,
 * so `sql.raw('x' as const)` and `sql.raw(NAME!)` are judged on what they wrap.
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSInstantiationExpression')
  ) {
    current = current.expression;
  }
  return current ?? null;
}

/** The property name of a member callee (`sql.raw`, `sql['raw']`), or `null`. */
function memberName(callee) {
  if (callee.computed) return staticString(callee.property);
  return callee.property.type === 'Identifier' ? callee.property.name : null;
}

/**
 * The builder this call is, as `{ index, label, reportNode }`, or `null`.
 * `reportNode` is the callee's name token: a tight squiggle, and — load-bearing
 * for the escape hatch — a line that is the line the `.as(` / `sql.raw(` is
 * written on, even inside a multi-line chain.
 */
function builderCall(node) {
  const callee = node.callee;

  if (callee.type === 'Identifier') {
    const index = FREE_BUILDERS.get(callee.name);
    if (index === undefined) return null;
    return { index, label: `${callee.name}()`, reportNode: callee };
  }

  if (callee.type !== 'MemberExpression') return null;
  const name = memberName(callee);
  if (name === null) return null;
  const index = MEMBER_BUILDERS.get(name);
  if (index === undefined) return null;

  const receiver = callee.object.type === 'Identifier' ? callee.object.name : null;
  if (name !== 'as' && !(receiver !== null && SQL_TAG_RECEIVERS.has(receiver))) return null;

  return {
    index,
    label: `${name === 'as' ? '' : `${receiver}.`}${name}()`,
    reportNode: callee.property,
  };
}

/** What an argument is, for the message — enough to see why it was flagged. */
function describe(argument) {
  if (!argument) return 'nothing';
  if (argument.type === 'SpreadElement') return 'a spread argument';
  const inner = unwrap(argument);
  if (inner?.type === 'TemplateLiteral') return 'an interpolated template literal';
  if (inner?.type === 'Identifier') return `the variable \`${inner.name}\``;
  if (inner?.type === 'MemberExpression' || inner?.type === 'CallExpression') {
    return 'a computed value';
  }
  return 'a non-literal expression';
}

const DIRECTIVE = /^\s*eslint-disable(-next-line|-line)?\b([\s\S]*)$/;

/**
 * Splits a directive's rule list from its `-- description`. The separator is
 * ESLint's own (`/\s-{2,}\s/`, leftmost match) so this rule and ESLint always
 * agree on where the rule names stop — a divergence would have the linter
 * reading `foo --` as a rule name while this rule read an empty reason.
 */
function parseDirective(comment) {
  // NOT trimmed: ESLint's separator needs the whitespace that follows the
  // dashes, and a trailing `-- ` is exactly the empty justification this rule
  // must catch.
  const match = DIRECTIVE.exec(comment.value);
  if (!match) return null;
  const rest = match[2] ?? '';
  const described = /\s-{2,}\s([\s\S]*)$/.exec(rest);
  const rulesText = described ? rest.slice(0, described.index) : rest;
  return {
    form: match[1] ?? '',
    rules: rulesText
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    description: described ? (described[1] ?? '').trim() : null,
  };
}

/** `sql/no-dynamic-identifier` and a bare `no-dynamic-identifier` both count. */
function namesRule(entry, ruleId) {
  return entry === ruleId || entry.split('/').pop() === ruleId.split('/').pop();
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a literal argument to every SQL identifier builder (sql.identifier, sql.raw, drizzle alias(), .as()); exemptions must state their reason.',
    },
    messages: {
      dynamic:
        '`{{label}}` builds SQL text from {{what}}. Identifiers cannot be parameterised, so this argument is concatenated into the statement verbatim — pass a string literal, or, if the value is provably from a closed allow-list, exempt this one call with `// eslint-disable-next-line {{ruleId}} -- <which list>`.',
      missingReason:
        'This exemption from {{ruleId}} states no reason. Write `// eslint-disable-next-line {{ruleId}} -- <why the value is from a closed allow-list>`.',
      wrongForm:
        'Line {{line}} exempts {{ruleId}} with `eslint-disable{{form}}`, which covers more than the one call it was written for. Use `// eslint-disable-next-line {{ruleId}} -- <why the value is from a closed allow-list>`.',
      blanketNextLine:
        'This blanket `eslint-disable-next-line` also suppresses {{ruleId}} on the next line. Name the rule and the reason: `// eslint-disable-next-line {{ruleId}} -- <why the value is from a closed allow-list>`.',
      blanketWide:
        'Line {{line}} carries a blanket `eslint-disable{{form}}` that also suppresses {{ruleId}} in this file. Name the rule and the reason on the call itself: `// eslint-disable-next-line {{ruleId}} -- <why the value is from a closed allow-list>`.',
    },
    schema: [],
  },
  create(context) {
    const ruleId = context.id ?? 'sql/no-dynamic-identifier';
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    /** Lines carrying a flagged builder call — what a blanket directive hides. */
    const flagged = new Set();
    /** Reported at the file head, where a self-suppressing directive cannot reach. */
    const fileHead = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };

    return {
      CallExpression(node) {
        const builder = builderCall(node);
        if (!builder) return;
        const argument = node.arguments[builder.index];
        // No argument at all is a different mistake (or another library's
        // zero-arg `.as()`); nothing is concatenated, so there is nothing here.
        if (!argument) return;
        if (argument.type !== 'SpreadElement' && staticString(argument) !== null) return;

        flagged.add(builder.reportNode.loc.start.line);
        context.report({
          node: builder.reportNode,
          messageId: 'dynamic',
          data: { label: builder.label, what: describe(argument), ruleId },
        });
      },

      'Program:exit'() {
        for (const comment of sourceCode.getAllComments()) {
          const directive = parseDirective(comment);
          if (!directive) continue;
          const line = comment.loc.start.line;

          if (directive.rules.length === 0) {
            // A blanket directive is only this rule's business when it actually
            // sits over one of this rule's findings.
            if (directive.form === '-next-line') {
              if (flagged.has(comment.loc.end.line + 1)) {
                context.report({
                  loc: comment.loc,
                  messageId: 'blanketNextLine',
                  data: { ruleId },
                });
              }
            } else if (directive.form === '-line') {
              if (flagged.has(line)) {
                context.report({
                  loc: fileHead,
                  messageId: 'blanketWide',
                  data: { ruleId, line, form: directive.form },
                });
              }
            } else if (flagged.size > 0) {
              context.report({
                loc: fileHead,
                messageId: 'blanketWide',
                data: { ruleId, line, form: directive.form },
              });
            }
            continue;
          }

          if (!directive.rules.some((entry) => namesRule(entry, ruleId))) continue;

          // The `-line` and block forms suppress their own diagnostic, so that
          // one is reported at the file head instead of at the comment.
          if (directive.form !== '-next-line') {
            context.report({
              loc: fileHead,
              messageId: 'wrongForm',
              data: { ruleId, line, form: directive.form },
            });
            continue;
          }

          if (!directive.description) {
            context.report({ loc: comment.loc, messageId: 'missingReason', data: { ruleId } });
          }
        }
      },
    };
  },
};
