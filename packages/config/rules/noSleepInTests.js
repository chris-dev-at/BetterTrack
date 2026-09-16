/**
 * `tests/no-sleep` — the deterministic-wait gate for test sources.
 *
 * PROJECTPLAN.md §12 asks unit/service tests to be "milliseconds-fast" and to
 * gate every commit. `await new Promise((r) => setTimeout(r, 30))` breaks that
 * promise twice over:
 *
 *   * it costs its 30 ms whether the thing it waits for took 1 ms or never
 *     happened at all, and
 *   * it is a claim about the MACHINE, not about the code: on a loaded runner
 *     the awaited work takes longer than the window and the suite goes red with
 *     no assertion failure anywhere. That is the recorded incident where mass
 *     timeouts with zero assertion failures faked a regression for hours.
 *
 * Issue #1622 removed the 33 of these in the liveMode / events / realtime /
 * apiKey suites. This rule is what stops the 34th being written: nothing kept
 * the pattern out, and "we fixed them all once" is not a property of code
 * anybody was checking.
 *
 * ── What it matches, and why exactly that ───────────────────────────────────
 * A `setTimeout`/`setInterval` inside a `new Promise` executor that takes AT
 * MOST ONE parameter. A one-parameter executor has no `reject`, so the timer
 * cannot be a deadline — the only thing such a promise can do is resolve when
 * the clock says so. That is the sleep.
 *
 * The two-parameter form `new Promise((resolve, reject) => { const t =
 * setTimeout(() => reject(…), ms); … })` is the OPPOSITE construct: a bounded
 * deadline on a wait for a real completion, which is what a sleep should be
 * replaced BY. It is deliberately not matched, and `apps/api/src/test/waitFor.ts`
 * holds the shared helpers built on it (`waitForEvent`, `waitForSocketEvent`).
 *
 * The gate therefore has no opinion about `setTimeout` as such — production
 * code, fake-timer plumbing and deadline helpers are all untouched. It has an
 * opinion about a promise whose entire body is a clock.
 *
 * ── The replacements, in the order to reach for them ────────────────────────
 *   1. Await the completion itself: a delivery promise, `once(emitter, 'x')`,
 *      `waitForSocketEvent(socket, 'x')`, the `subscribe()` whose resolution IS
 *      the registration, a `vi.waitFor` around a repository read.
 *   2. Own the clock: `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(n)`
 *      where the unit under test schedules its own timers.
 *   3. For "prove nothing further happened", find a BARRIER — a round-trip the
 *      server acks on the same connection, a second event on the same channel,
 *      a still-live loop ticking N more times. A barrier scales with the
 *      machine; a fixed window cannot.
 *
 * ── The escape hatch, and why it is shaped like this ────────────────────────
 * A few sites really are "let the runtime hand control back" or a fixture that
 * must be slow (the input to a timeout guard). Those are exempted with
 *
 *     // eslint-disable-next-line tests/no-sleep -- <why no completion exists>
 *
 * and, as with `sql/no-dynamic-identifier`, the rule polices the exemption:
 *
 *   * the directive MUST be the `-next-line` form — the block and `-line` forms
 *     exempt more than the one wait they were written for;
 *   * it MUST carry a `--` description naming what completion is missing;
 *   * a blanket directive (no rule names) sitting over a finding is reported
 *     too, so a bare `// eslint-disable-next-line` cannot quietly swallow one.
 *
 * Diagnostics about a self-suppressing directive are reported at the top of the
 * file, where that directive's window cannot reach — the same residual hole as
 * the SQL gate (a block disable on line 1 covers even the line-1 report), stated
 * rather than implied away.
 *
 * ── Known limits ───────────────────────────────────────────────────────────
 * `Promise` is matched by name, so a renamed binding defeats it; a sleep hidden
 * behind a helper in another module (`await sleep(30)`) is invisible here, which
 * is why the repo has no such helper and should not grow one. This is a lint,
 * not a proof.
 */

const TIMER_NAMES = new Set(['setTimeout', 'setInterval']);

/** Is `node` any function form that can be a promise executor? */
function isFunction(node) {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}

/** The bare `setTimeout(…)` / `setInterval(…)` / `globalThis.setTimeout(…)` name. */
function timerName(node) {
  const callee = node.callee;
  if (callee.type === 'Identifier') return TIMER_NAMES.has(callee.name) ? callee.name : null;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    TIMER_NAMES.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

const DIRECTIVE = /^\s*eslint-disable(-next-line|-line)?\b([\s\S]*)$/;

/**
 * Splits a directive's rule list from its `-- description`, using ESLint's own
 * separator (`/\s-{2,}\s/`, leftmost match) so this rule and ESLint never
 * disagree about where the rule names stop.
 */
function parseDirective(comment) {
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

/** `tests/no-sleep` and a bare `no-sleep` both count. */
function namesRule(entry, ruleId) {
  return entry === ruleId || entry.split('/').pop() === ruleId.split('/').pop();
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid sleep-based waits in test sources: a `new Promise` whose single-parameter executor only sets a timer. Await the completion, drive fake timers, or use a barrier; exemptions must state their reason.',
    },
    messages: {
      sleep:
        'This is a sleep, not a wait: `new Promise((…) => {{timer}}(…))` resolves on the clock, so it costs its full delay when the work is instant and goes red when a loaded machine is slower than the guess — with no assertion failure to explain it. Await the completion instead (a delivery promise, `waitForSocketEvent`, a `vi.waitFor` around the read), drive the unit\'s own timers with `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, or — for "nothing further happened" — use a barrier that scales with the machine. If no completion signal exists, exempt this one wait with `// eslint-disable-next-line {{ruleId}} -- <which completion is missing>`.',
      missingReason:
        'This exemption from {{ruleId}} states no reason. Write `// eslint-disable-next-line {{ruleId}} -- <which completion signal is missing>`.',
      wrongForm:
        'Line {{line}} exempts {{ruleId}} with `eslint-disable{{form}}`, which covers more than the one wait it was written for. Use `// eslint-disable-next-line {{ruleId}} -- <which completion signal is missing>`.',
      blanketNextLine:
        'This blanket `eslint-disable-next-line` also suppresses {{ruleId}} on the next line. Name the rule and the reason: `// eslint-disable-next-line {{ruleId}} -- <which completion signal is missing>`.',
      blanketWide:
        'Line {{line}} carries a blanket `eslint-disable{{form}}` that also suppresses {{ruleId}} in this file. Name the rule and the reason on the wait itself: `// eslint-disable-next-line {{ruleId}} -- <which completion signal is missing>`.',
    },
    schema: [],
  },
  create(context) {
    const ruleId = context.id ?? 'tests/no-sleep';
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    /** Lines carrying a finding — what a blanket directive would hide. */
    const flagged = new Set();
    const fileHead = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };

    return {
      CallExpression(node) {
        const timer = timerName(node);
        if (timer === null) return;

        // Walk out to the nearest enclosing function. Only that one can be the
        // promise executor: anything further out has a function between it and
        // the timer, and that inner function is where the timer really lives.
        const ancestors = sourceCode.getAncestors
          ? sourceCode.getAncestors(node)
          : context.getAncestors();
        let executor = null;
        let executorParent = null;
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          if (!isFunction(ancestors[i])) continue;
          executor = ancestors[i];
          executorParent = i > 0 ? ancestors[i - 1] : null;
          break;
        }
        if (!executor || executor.params.length > 1) return;
        if (
          !executorParent ||
          executorParent.type !== 'NewExpression' ||
          executorParent.callee.type !== 'Identifier' ||
          executorParent.callee.name !== 'Promise' ||
          executorParent.arguments[0] !== executor
        ) {
          return;
        }

        flagged.add(node.loc.start.line);
        context.report({ node, messageId: 'sleep', data: { timer, ruleId } });
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
