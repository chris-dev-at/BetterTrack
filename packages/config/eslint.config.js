import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noCustomCategorySlice from './rules/noCustomCategorySlice.js';
import noLiteralJsxString from './rules/noLiteralJsxString.js';

/**
 * The i18n plugin holding the V3-P1 hardcoded-string gate (§13.3). Applied only
 * to the extracted user surfaces below — see `docs/i18n.md` for scope + how to
 * opt a surface in as it is migrated.
 */
const i18nPlugin = { rules: { 'no-literal-jsx-string': noLiteralJsxString } };

/**
 * The V3-P2 CUSTOM-slice gate (§13.3, issue #325): the dead custom-category
 * tokens (`real_estate`/`vehicle`/`collectible`) and the standalone CUSTOM
 * holdings slice must never re-enter any non-test source, so the "custom assets
 * group by their catalog category everywhere" guarantee cannot silently
 * regress (e.g. when V3-P9 Analytics inherits these categories). Scoped
 * tree-wide below — see `rules/noCustomCategorySlice.js`.
 */
const taxonomyPlugin = { rules: { 'no-custom-category-slice': noCustomCategorySlice } };

/**
 * Non-test app + contract source the CUSTOM-slice gate sweeps. Broad on purpose:
 * unlike the per-surface i18n list above, the whole point is that *any* new
 * grouping surface anywhere is covered without an opt-in.
 */
const TAXONOMY_GATED_SOURCES = [
  'apps/web/src/**/*.{ts,tsx}',
  'apps/api/src/**/*.{ts,tsx}',
  'packages/contracts/src/**/*.ts',
];

/**
 * User-facing surfaces whose copy is fully routed through the i18n layer, so a
 * newly-introduced hardcoded string is a lint (and therefore CI) failure. Adding
 * a surface here after extracting it is the mechanism that grows the gate as each
 * later V3 phase migrates its strings.
 */
const I18N_GATED_SURFACES = [
  // The whole user app (V3-P13) plus the shared user-facing widgets. The admin
  // app (`apps/web/src/admin/**`) is English-by-design and stays out.
  'apps/web/src/user/**/*.tsx',
  'apps/web/src/ui/**/*.tsx',
];

/**
 * Shared flat ESLint config for the BetterTrack monorepo.
 * Non-type-checked TypeScript linting: fast and robust across packages.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // TypeScript's own checker handles undefined symbols.
      'no-undef': 'off',
      // Allow intentionally-unused args/vars when prefixed with `_`
      // (e.g. Express `(err, _req, res, _next)` error handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // V3-P1 hardcoded-string gate (§13.3): user copy on the extracted surfaces
    // must go through the i18n layer. Test files are exempt (they assert on the
    // rendered EN source strings).
    files: I18N_GATED_SURFACES,
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { i18n: i18nPlugin },
    rules: {
      'i18n/no-literal-jsx-string': 'error',
    },
  },
  {
    // V3-P2 CUSTOM-slice gate (§13.3, issue #325): no dead custom-category token
    // and no CUSTOM holdings slice in any non-test app/contract source. Tests are
    // exempt (they assert on the tokens on purpose — e.g. the migration test).
    files: TAXONOMY_GATED_SOURCES,
    ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    plugins: { taxonomy: taxonomyPlugin },
    rules: {
      'taxonomy/no-custom-category-slice': 'error',
    },
  },
  prettier,
);
