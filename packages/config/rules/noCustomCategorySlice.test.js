import { test } from 'node:test';

import { RuleTester } from 'eslint';

import rule from './noCustomCategorySlice.js';

/**
 * Proves the V3-P2 CUSTOM-slice gate fires (PROJECTPLAN.md §13.3, issue #325):
 * the dead custom-category tokens and a `custom` key inside an asset-type map are
 * lint errors, while the catalog taxonomy and unrelated `custom` keys pass. Uses
 * the built-in espree parser — no extra dependency.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

test('no-custom-category-slice flags dead tokens and the CUSTOM slice, passes the catalog taxonomy', () => {
  ruleTester.run('no-custom-category-slice', rule, {
    valid: [
      // The catalog taxonomy — no CUSTOM slice, no dead tokens.
      {
        code: "const L = { stock: 'Stocks', etf: 'ETFs', cash_like: 'Cash-like', other: 'Other' };",
      },
      // A cash-source-kind map: `custom` is a legitimately different concept and
      // the map has no `stock` key, so it is left alone.
      {
        code: "const K = { bank: 'Bank', retirement: 'Retirement', cash: 'Cash', custom: 'Custom' };",
      },
      // A lone / unrelated `custom` key never matches.
      { code: "const cfg = { custom: 'anything' };" },
      // A badge/style map keyed on `stock` but with no `custom` entry.
      { code: "const B = { stock: 'bg-sky', etf: 'bg-violet' };" },
      // Plain business strings that merely contain the words are fine.
      { code: "const s = 'Custom Assets';" },
    ],
    invalid: [
      // The exact TYPE_LABELS / TYPE_BADGE regression: a `custom` slice next to
      // the asset types.
      {
        code: "const L = { stock: 'Stocks', etf: 'ETFs', custom: 'Custom' };",
        errors: [{ messageId: 'slice' }],
      },
      // Each dead custom-category enum token, as a string literal anywhere.
      { code: "const c = 'real_estate';", errors: [{ messageId: 'deadToken' }] },
      { code: "const c = 'vehicle';", errors: [{ messageId: 'deadToken' }] },
      { code: "const c = 'collectible';", errors: [{ messageId: 'deadToken' }] },
      // A dead token used as a category value in an object.
      {
        code: "const a = { category: 'real_estate' };",
        errors: [{ messageId: 'deadToken' }],
      },
    ],
  });
});
