import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noCustomCategorySlice from './rules/noCustomCategorySlice.js';
import noDynamicSqlIdentifier from './rules/noDynamicSqlIdentifier.js';
import noLiteralJsxString from './rules/noLiteralJsxString.js';
import noSleepInTests from './rules/noSleepInTests.js';
import requirePasswordSignInHelper from './rules/requirePasswordSignInHelper.js';

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

/** Keeps password login selectors out of specs and in the shared e2e helper. */
const e2ePlugin = { rules: { 'require-password-sign-in-helper': requirePasswordSignInHelper } };

/**
 * The SQL-identifier reachability gate. Drizzle parameterises values but cannot
 * parameterise identifiers, so `sql.identifier()`, `sql.raw()`, `alias()` and
 * `.as()` are the only places a JavaScript string becomes SQL text verbatim. The
 * vault/paranoid review signed those call sites off on the claim that no
 * user-controlled string reaches them; this plugin is what keeps the claim true
 * — see `rules/noDynamicSqlIdentifier.js`, which also polices the reason every
 * exemption has to carry.
 */
const sqlPlugin = { rules: { 'no-dynamic-identifier': noDynamicSqlIdentifier } };

/**
 * The deterministic-wait gate (issue #1622). `await new Promise((r) =>
 * setTimeout(r, 30))` is a claim about the machine, not about the code: it
 * costs its full delay when the work was instant, and goes red with no
 * assertion failure when a loaded runner is slower than the guess — the
 * recorded incident where mass timeouts faked a regression for hours. #1622
 * replaced the 33 of these in the liveMode / events / realtime / apiKey suites
 * with the completion each one was waiting for; this rule is what keeps them
 * gone. It matches only a `new Promise` whose single-parameter executor sets a
 * timer — the two-parameter `(resolve, reject)` deadline form, which is the
 * REPLACEMENT, is deliberately untouched. See `rules/noSleepInTests.js`, which
 * also polices the reason every exemption has to carry.
 */
const testsPlugin = { rules: { 'no-sleep': noSleepInTests } };

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
 * Everything that can speak drizzle. Narrower than the taxonomy gate because
 * `.as()` is matched on ANY receiver — a SQL builder here, somebody else's
 * fluent API in `apps/web` — and wider than "repositories" because the point is
 * that a new drizzle caller anywhere in these trees is covered without an
 * opt-in. Tests are deliberately NOT exempt: a test is where an unsafe
 * "interpolate the table name" helper gets written first and copied second.
 */
/**
 * Test sources the no-sleep gate covers. The API tree is where every one of the
 * 33 lived; `packages/*` and `e2e` join it so the pattern cannot simply move.
 */
const NO_SLEEP_GATED_SOURCES = [
  'apps/api/src/**/*.test.ts',
  'apps/web/src/**/*.test.{ts,tsx}',
  'packages/*/src/**/*.test.ts',
  'e2e/**/*.spec.ts',
  // The test-support modules themselves. A sleep helper written HERE would be
  // invisible to the gate at every call site — `await sleep(30)` names no timer
  // — so the one place it could be introduced is covered directly. The shared
  // deadline helpers in `apps/api/src/test/waitFor.ts` pass: each uses the
  // two-parameter `(resolve, reject)` executor the rule does not match.
  'apps/api/src/test/**/*.ts',
  'apps/api/src/testing/**/*.ts',
];

/**
 * Test files the gate does not cover YET, each because another lane owns the
 * file while #1622 lands and a fix here would collide with it. This list only
 * shrinks: the follow-up removes an entry as its lane merges. Adding a NEW name
 * here is not how this rule is meant to be satisfied — the escape hatch is a
 * per-wait `eslint-disable-next-line tests/no-sleep -- <reason>`, which at least
 * says what completion is missing.
 */
const NO_SLEEP_GATE_PENDING = [
  // TODO(after #2017, #2005, #1649) — three open PRs still edit the mirror
  // replication suite; #2008 landed but did not take its three waits with it.
  'apps/api/src/__tests__/mirrorReplication.test.ts',
  // TODO(after #1569) — vault lanes A/B own the paranoid/vault account suites.
  'apps/api/src/services/account/__tests__/**',
  // TODO(after #1568) — import re-stage lane owns the import suites.
  'apps/api/src/services/imports/__tests__/**',
  // TODO(after #1569) — vault lanes A/B own the web vault keystore/store tests.
  'apps/web/src/user/vault/**',
  // The web suites #1622 did not reach (its scope was the API's realtime/event
  // families). Five waits across four files, each needing the same
  // completion-or-fake-timers treatment.
  // TODO(follow-up to #1622) — convert these, then delete the four entries.
  'apps/web/src/user/components/AssetSearchBox.test.tsx',
  'apps/web/src/user/control/panels/AccountPanel.test.tsx',
  'apps/web/src/user/workboard/ConglomerateBuilderPage.test.tsx',
  'apps/web/src/user/workboard/WorkboardPage.test.tsx',
];

const SQL_IDENTIFIER_GATED_SOURCES = [
  'apps/api/src/**/*.ts',
  'packages/*/src/**/*.ts',
  'e2e/**/*.ts',
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
  {
    // The SQL-identifier reachability gate: every identifier builder takes a
    // literal, and every exemption states which closed allow-list its value
    // comes from. See `rules/noDynamicSqlIdentifier.js`.
    files: SQL_IDENTIFIER_GATED_SOURCES,
    plugins: { sql: sqlPlugin },
    rules: {
      'sql/no-dynamic-identifier': 'error',
    },
  },
  {
    // The deterministic-wait gate: no sleep-based waits in test sources. The
    // ignore list is the in-flight lanes' files, shrinking as each merges.
    files: NO_SLEEP_GATED_SOURCES,
    ignores: NO_SLEEP_GATE_PENDING,
    plugins: { tests: testsPlugin },
    rules: {
      'tests/no-sleep': 'error',
    },
  },
  {
    // Playwright role-name matching is substring-based. The login page's passkey
    // button includes "Sign in", so specs must use the helper's exact locator.
    files: ['e2e/**/*.spec.ts'],
    plugins: { e2e: e2ePlugin },
    rules: {
      'e2e/require-password-sign-in-helper': 'error',
    },
  },
  prettier,
);
