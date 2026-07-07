import { test } from 'node:test';

import { RuleTester } from 'eslint';

import rule from './noLiteralJsxString.js';

/**
 * Proves the V3-P1 hardcoded-string gate fires (PROJECTPLAN.md §13.3): a raw JSX
 * string is a lint error, while copy routed through `t('…')` passes. Uses the
 * built-in espree parser with JSX enabled — no extra dependency.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test('no-literal-jsx-string flags hard-coded copy and passes t() calls', () => {
  ruleTester.run('no-literal-jsx-string', rule, {
    valid: [
      // Copy goes through the i18n layer.
      { code: "const A = () => <p>{t('greeting')}</p>;" },
      // Dynamic values and technical attributes are fine.
      { code: 'const A = ({ name }) => <span>{name}</span>;' },
      { code: 'const A = () => <div className="p-4" data-testid="x" />;' },
      { code: 'const A = () => <input type="text" name="email" />;' },
      // Symbols / punctuation / digits are not copy.
      { code: 'const A = () => <span>—</span>;' },
      { code: 'const A = () => <span>·</span>;' },
      // Translated attribute.
      { code: "const A = () => <input aria-label={t('search')} />;" },
    ],
    invalid: [
      // Visible text between tags.
      {
        code: 'const A = () => <p>Hello world</p>;',
        errors: [{ messageId: 'text' }],
      },
      // A button label.
      {
        code: 'const A = () => <button>Save changes</button>;',
        errors: [{ messageId: 'text' }],
      },
      // A user-facing attribute string.
      {
        code: 'const A = () => <input placeholder="Your name" />;',
        errors: [{ messageId: 'attribute' }],
      },
    ],
  });
});
