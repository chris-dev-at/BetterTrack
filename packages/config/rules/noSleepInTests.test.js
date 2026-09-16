import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './noSleepInTests.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const tsRuleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

test('no-sleep flags a promise whose whole body is a timer', () => {
  ruleTester.run('tests/no-sleep', rule, {
    valid: [
      // The construct sleeps should be replaced BY: a bounded deadline on a wait
      // for a real completion. Two parameters, so the timer can reject.
      {
        code: `new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out')), 1000);
          socket.once('x', (v) => { clearTimeout(timer); resolve(v); });
        });`,
      },
      // A deadline racing a real completion, written the other way round.
      {
        code: `new Promise((resolve, reject) => {
          setTimeout(reject, 1000);
          emitter.once('done', resolve);
        });`,
      },
      // Owning the clock is the fix, not the offence.
      { code: 'await vi.advanceTimersByTimeAsync(60);' },
      // Timers outside a promise executor are nobody's business here: the unit
      // under test schedules them, a helper stores one, a spy inspects one.
      { code: 'const timer = setTimeout(() => tick(), 20); clearTimeout(timer);' },
      { code: "vi.spyOn(globalThis, 'setTimeout');" },
      { code: 'function poll() { setInterval(() => sweep(), 50); }' },
      // A one-parameter executor with no timer at all.
      { code: 'new Promise((resolve) => server.close(() => resolve()));' },
      // Not `Promise`. The rule matches the constructor by name and says so.
      { code: 'new Deferred((resolve) => setTimeout(resolve, 10));' },
      // The timer is inside a nested function that is NOT the executor — it is
      // the callback the executor hands to something else.
      {
        code: `new Promise((resolve) => {
          scheduler.run(() => setTimeout(resolve, 10));
        });`,
      },
    ],
    invalid: [
      // The exact 33 shapes #1622 removed.
      {
        code: 'await new Promise((r) => setTimeout(r, 30));',
        errors: [{ messageId: 'sleep' }],
      },
      {
        code: 'await new Promise((resolve) => setTimeout(resolve, 0));',
        errors: [{ messageId: 'sleep' }],
      },
      {
        code: 'await new Promise((resolve) => { setTimeout(resolve, 100); });',
        errors: [{ messageId: 'sleep' }],
      },
      {
        code: "await new Promise((resolve) => setTimeout(() => resolve('late'), 50));",
        errors: [{ messageId: 'sleep' }],
      },
      // A zero-parameter executor cannot resolve on anything but the clock either.
      {
        code: 'await new Promise(() => setTimeout(done, 10));',
        errors: [{ messageId: 'sleep' }],
      },
      // `setInterval` in the same position is the same mistake.
      {
        code: 'new Promise((resolve) => setInterval(resolve, 10));',
        errors: [{ messageId: 'sleep' }],
      },
      // Via the global object, which is how a fake-timer-aware test spells it.
      {
        code: 'await new Promise((r) => globalThis.setTimeout(r, 5));',
        errors: [{ messageId: 'sleep' }],
      },
    ],
  });

  // TypeScript spellings: a type argument on the constructor must not hide it.
  tsRuleTester.run('tests/no-sleep', rule, {
    valid: [
      {
        code: `new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('x')), 100);
          done.then(() => { clearTimeout(t); resolve(); });
        });`,
      },
    ],
    invalid: [
      {
        code: 'await new Promise<void>((resolve) => setTimeout(resolve, 0));',
        errors: [{ messageId: 'sleep' }],
      },
    ],
  });
});

const linter = new Linter();

/**
 * Lints under the rule's REAL id, the one `eslint.config.js` registers — which
 * is also what proves the rule's prefix-independent name matching. ESLint's own
 * unused-directive housekeeping is off, so every message here is the rule's.
 */
function lint(code) {
  return linter.verify(code, {
    plugins: { tests: { rules: { 'no-sleep': rule } } },
    rules: { 'tests/no-sleep': 'error' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
}

const summarise = (messages) => messages.map((m) => `${m.messageId ?? m.ruleId}@${m.line}`);

test('the escape hatch is policed under the real rule id', () => {
  // The sanctioned form: named rule, `--` reason, one line of reach.
  assert.deepEqual(
    summarise(
      lint(
        [
          '// eslint-disable-next-line tests/no-sleep -- no completion: the fixture must outlast the guard',
          'await new Promise((r) => setTimeout(r, 50));',
        ].join('\n'),
      ),
    ),
    [],
  );

  // Named, but with nothing said about WHY — the way a gate rots a second time.
  assert.deepEqual(
    summarise(
      lint(
        [
          '// eslint-disable-next-line tests/no-sleep',
          'await new Promise((r) => setTimeout(r, 50));',
        ].join('\n'),
      ),
    ),
    ['missingReason@1'],
  );

  // The `-line` and block forms exempt more than the one wait they were written
  // for, and suppress a diagnostic on their own line — so theirs lands at line 1.
  assert.deepEqual(
    summarise(
      lint(
        [
          'const x = 1;',
          'await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line tests/no-sleep -- reason',
        ].join('\n'),
      ),
    ),
    ['wrongForm@1'],
  );

  assert.deepEqual(
    summarise(
      lint(
        [
          'const x = 1;',
          '/* eslint-disable tests/no-sleep -- reason */',
          'await new Promise((r) => setTimeout(r, 5));',
        ].join('\n'),
      ),
    ),
    ['wrongForm@1'],
  );

  // A blanket directive that happens to sit over a finding hides it without
  // naming anything — reported, so it cannot be used as a quiet exemption.
  assert.deepEqual(
    summarise(
      lint(
        ['// eslint-disable-next-line', 'await new Promise((r) => setTimeout(r, 5));'].join('\n'),
      ),
    ),
    ['blanketNextLine@1'],
  );

  assert.deepEqual(
    summarise(
      lint(
        [
          'const x = 1;',
          '/* eslint-disable */',
          'await new Promise((r) => setTimeout(r, 5));',
        ].join('\n'),
      ),
    ),
    ['blanketWide@1'],
  );

  // A blanket disable with NO finding under it is none of this rule's business.
  assert.deepEqual(
    summarise(lint(['/* eslint-disable */', 'const t = setTimeout(tick, 5);'].join('\n'))),
    [],
  );

  // The documented residual hole, asserted rather than hoped about: a directive
  // on line 1 suppresses the line-1 report about itself.
  assert.deepEqual(
    summarise(lint('await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line')),
    [],
  );
});
