/**
 * `no-literal-jsx-string` — the V3-P1 hardcoded-string CI gate (PROJECTPLAN.md
 * §13.3). Flags user-facing string literals in JSX so every phase after V3-P1 is
 * forced to route copy through the i18n layer (`t('key')`); a hardcoded string is
 * a blocking finding.
 *
 * Scoped by `files` globs in `eslint.config.js` to the extracted user surfaces
 * (nav, settings, auth, portfolio, workboard). Everything not yet migrated —
 * admin internals, shared widgets, log lines, test files — is exempt via those
 * globs; see `docs/i18n.md`.
 *
 * Two shapes are flagged, chosen to keep false positives near zero:
 *   1. **JSXText** — visible copy between tags — when it contains a word of two
 *      or more letters (so `—`, `·`, `{`, digits and punctuation are ignored).
 *   2. **String literals in user-facing JSX attributes** — an allowlist of
 *      `placeholder` / `title` / `alt` / `aria-label` (so `className`, `type`,
 *      `name`, ids, technical enums, etc. are never touched).
 *
 * `{t('…')}` and any other `{expression}` are JSXExpressionContainers, not
 * literals, so they pass untouched.
 */

/** JSX attributes whose string value is shown to the user. */
const TEXT_ATTRIBUTES = new Set(['placeholder', 'title', 'alt', 'aria-label']);

/** A run of ≥2 letters (any script) — the signal that text is human copy. */
const HAS_WORD = /\p{L}{2,}/u;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded user-facing JSX strings; route copy through the i18n t() layer.',
    },
    messages: {
      text: 'Hard-coded UI string "{{text}}". Move it into the i18n layer (t(\'…\')).',
      attribute:
        'Hard-coded UI string in `{{attr}}`: "{{text}}". Move it into the i18n layer (t(\'…\')).',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        if (HAS_WORD.test(node.value)) {
          context.report({
            node,
            messageId: 'text',
            data: { text: node.value.trim().slice(0, 40) },
          });
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const attr = node.name.name;
        if (!TEXT_ATTRIBUTES.has(attr)) return;
        const value = node.value;
        if (value && value.type === 'Literal' && typeof value.value === 'string') {
          if (HAS_WORD.test(value.value)) {
            context.report({
              node: value,
              messageId: 'attribute',
              data: { attr, text: value.value.slice(0, 40) },
            });
          }
        }
      },
    };
  },
};
