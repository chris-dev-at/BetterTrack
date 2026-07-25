/**
 * `require-password-sign-in-helper` keeps password sign-in interaction in the
 * shared e2e helper. In particular, Playwright role-name matching is substring
 * based, so the old bare "Sign in" locator also selected "Sign in with a
 * passkey" and failed strict mode before the assertion ran.
 */

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function propertyName(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  return staticString(property.key);
}

function isPasswordSignInLocator(node) {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return false;
  if (node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'getByRole') {
    return false;
  }
  if (staticString(node.arguments[0]) !== 'button') return false;

  const options = node.arguments[1];
  if (options?.type !== 'ObjectExpression') return false;
  return options.properties.some(
    (property) => propertyName(property) === 'name' && staticString(property.value) === 'Sign in',
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require e2e specs to use the shared passwordSignIn helper instead of a direct Sign in button locator.',
    },
    messages: {
      helper:
        'Use passwordSignIn() from e2e/support/auth instead of a direct "Sign in" button locator. A bare role-name locator also matches "Sign in with a passkey".',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isPasswordSignInLocator(node)) {
          context.report({ node, messageId: 'helper' });
        }
      },
    };
  },
};
