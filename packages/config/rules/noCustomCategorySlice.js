/**
 * `no-custom-category-slice` — the V3-P2 CUSTOM-slice CI gate (PROJECTPLAN.md
 * §13.3, issue #325). Custom assets v2 replaced the old
 * `real_estate | vehicle | collectible` category enum AND the standalone
 * "CUSTOM" holdings slice with the shared catalog taxonomy: a custom "stock"
 * now groups under Stocks everywhere. The acceptance criterion is systematic —
 * *"No CUSTOM category/slice remains in any UI or API response"* — but the fix
 * kept surfacing one holdings-by-type surface at a time. This rule is the guard
 * the criterion names: a new or overlooked grouping surface that reintroduces
 * the dead taxonomy fails `pnpm lint` (and therefore CI), so the guarantee can
 * never silently regress (e.g. when V3-P9 Analytics inherits these categories).
 *
 * Scoped in `eslint.config.js` to all non-test app + contract source. Flags two
 * shapes, chosen to keep false positives near zero:
 *   1. **A dead custom-category token** — a string `Literal` equal to
 *      `real_estate` / `vehicle` / `collectible`, the enum removed by migration
 *      0022. These tokens are dead forever. Prose mentions survive only in
 *      comments, which are not `Literal` nodes, so the surviving doc comments
 *      pass untouched.
 *   2. **A CUSTOM slice in an asset-type map** — a `custom` key inside an object
 *      literal that also carries a `stock` key. That is the TYPE_LABELS /
 *      TYPE_BADGE shape (`{ stock: …, etf: …, custom: … }`); a `custom` entry in
 *      it is exactly the slice the taxonomy killed. The `stock`-key discriminator
 *      leaves unrelated maps alone — cash-source kinds are
 *      `{ bank, retirement, cash, custom }` (no `stock` key), and a lone
 *      `{ custom: … }` config object never matches.
 */

/** Custom-category enum values removed by migration 0022 — dead forever. */
const DEAD_TOKENS = new Set(['real_estate', 'vehicle', 'collectible']);

/**
 * The literal name a property is keyed on (`Identifier` `custom` or the string
 * literal `'custom'`), or `null` for computed keys, spreads, and methods.
 */
function propertyKeyName(prop) {
  if (prop.type !== 'Property' || prop.computed) return null;
  const key = prop.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the dead custom-category tokens (real_estate/vehicle/collectible) and the CUSTOM holdings slice; custom assets group by their catalog category.',
    },
    messages: {
      deadToken:
        'Dead custom-category token "{{token}}". Custom assets v2 (V3-P2) replaced the real_estate/vehicle/collectible enum with the shared catalog categories (stock/etf/crypto/commodity/cash_like/other).',
      slice:
        'CUSTOM slice: a `custom` key inside an asset-type map (it also keys `stock`). Group custom holdings by their catalog category (asset.category ?? asset.type) — no separate CUSTOM slice.',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string' && DEAD_TOKENS.has(node.value.trim())) {
          context.report({
            node,
            messageId: 'deadToken',
            data: { token: node.value.trim() },
          });
        }
      },
      ObjectExpression(node) {
        const keys = node.properties.map(propertyKeyName);
        // Only asset-type maps (those keyed on `stock`) can carry a CUSTOM slice;
        // ignore cash-source maps and unrelated `{ custom: … }` objects.
        if (!keys.includes('stock')) return;
        for (const prop of node.properties) {
          if (propertyKeyName(prop) === 'custom') {
            context.report({ node: prop, messageId: 'slice' });
          }
        }
      },
    };
  },
};
