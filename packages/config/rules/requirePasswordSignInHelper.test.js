import { test } from 'node:test';

import { RuleTester } from 'eslint';

import rule from './requirePasswordSignInHelper.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

test('require-password-sign-in-helper rejects direct password submit locators', () => {
  ruleTester.run('require-password-sign-in-helper', rule, {
    valid: [
      { code: "await passwordSignIn(page, 'alice', 'secret');" },
      { code: "page.getByRole('button', { name: 'Sign in with a passkey' });" },
      { code: "page.getByRole('button', { name: 'Create account' });" },
    ],
    invalid: [
      {
        code: "page.getByRole('button', { name: 'Sign in' });",
        errors: [{ messageId: 'helper' }],
      },
      {
        code: "page.getByRole('button', { name: 'Sign in', exact: true });",
        errors: [{ messageId: 'helper' }],
      },
    ],
  });
});
