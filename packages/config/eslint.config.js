import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noLiteralJsxString from './rules/noLiteralJsxString.js';

/**
 * The i18n plugin holding the V3-P1 hardcoded-string gate (§13.3). Applied only
 * to the extracted user surfaces below — see `docs/i18n.md` for scope + how to
 * opt a surface in as it is migrated.
 */
const i18nPlugin = { rules: { 'no-literal-jsx-string': noLiteralJsxString } };

/**
 * User-facing surfaces whose copy is fully routed through the i18n layer, so a
 * newly-introduced hardcoded string is a lint (and therefore CI) failure. Adding
 * a surface here after extracting it is the mechanism that grows the gate as each
 * later V3 phase migrates its strings.
 */
const I18N_GATED_SURFACES = [
  'apps/web/src/user/components/AppLayout.tsx',
  'apps/web/src/user/components/SubNav.tsx',
  'apps/web/src/user/components/ProfileMenu.tsx',
  'apps/web/src/user/auth/**/*.tsx',
  'apps/web/src/user/settings/**/*.tsx',
  'apps/web/src/user/portfolio/**/*.tsx',
  'apps/web/src/user/workboard/**/*.tsx',
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
  prettier,
);
