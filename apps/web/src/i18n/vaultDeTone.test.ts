import { describe, expect, test } from 'vitest';

import de from './messages/de.json';
import en from './messages/en.json';

type MessageNode = string | { [key: string]: MessageNode };

/**
 * The vault + paranoid-facing catalogs, EN ⇄ DE — STRUCTURE first, then tone
 * (#1640 residue 2).
 *
 * The previous shape of this file was a tone guard only, and its coverage came
 * from a hand-written list of six `de.vault.*` subtrees. Both halves of that
 * were guarantees resting on something other than the thing meant to guarantee
 * them:
 *
 *   • a NEW vault subtree shipped untone-checked, because nobody adds their own
 *     surface to somebody else's list; and
 *   • nothing here asserted that the two catalogs have the same SHAPE, so a key
 *     added to one locale only, or a `{{placeholder}}` dropped in translation,
 *     would surface as a raw dot-path or a broken interpolation in the UI.
 *     (Removing `vault.unlockDialog.custodyUnavailable` during VAULT-UX-B meant
 *     deleting it from both files by hand, with nothing local to catch a
 *     half-removal.)
 *
 * So the scope below is DERIVED from the catalog: every top-level namespace
 * whose name is about the vault, proven complete by the first test against the
 * catalog's own keys. `registry.test.ts` runs the same two parity assertions
 * repo-wide and is the broader net; these are the vault-scoped restatement that
 * keeps §12's requirement legible, and failing, in the file a vault change
 * actually touches.
 */

/**
 * Every catalog root this file governs.
 *
 * The list is explicit because the paranoid surface is NOT identifiable by root
 * name: `mirrorchain` (86 DE strings), `privacy` and `deleteAccount` carry
 * paranoid-facing copy and contain neither "vault" nor "paranoid". The first
 * test below is therefore a NAME heuristic and nothing more — it catches a new
 * `vault*`/`*paranoid*` root added outside this list, which is the common case,
 * and cannot catch a root named something else. Adding one of those is a
 * judgement call that belongs here, in the list.
 */
const VAULT_NAMESPACES = [
  'vault',
  'vaultExports',
  'vaultComposition',
  'vaultMoney',
  'paranoidFreshStart',
  // Paranoid-facing but not vault-named: §18's mirrorchain, the §3 destruction
  // exit and the privacy copy the shield chip explains. All clean today.
  'mirrorchain',
  'privacy',
  'deleteAccount',
] as const;

/**
 * Formal address in German. Capitalised `Sie`/`Ihr…` is the polite "you"; the
 * vault surfaces are deliberately informal (du/dein), calm and close, because
 * they carry irreversible decisions.
 */
const FORMAL_ADDRESS = /\b(?:Sie|Ihr|Ihnen|Ihren|Ihre|Ihrem|Ihres|Ihrer)\b/;

/**
 * The known FALSE POSITIVES: a capitalised `Sie`/`Ihr…` that is not the formal
 * address at all — here the feminine pronoun standing in for "die Kopie",
 * sentence-initial and therefore capitalised.
 *
 * Pinned by exact text, not merely by key, on purpose. Any edit to the copy
 * stops matching, the string is flagged again, and a human re-judges it; the
 * test below fails loudly when an entry goes stale in either direction, so an
 * exception can never quietly widen into a hole.
 */
const NOT_FORMAL_ADDRESS: Readonly<Record<string, string>> = {
  'vault.unlock.stuck.driveLeftover':
    'Die verschlüsselte Kopie in deinem Google Drive bleibt liegen. Sie lässt sich von niemandem mehr öffnen, auch nicht von dir — entferne die bettertrack-vault-Datei bei Bedarf selbst aus Drive.',
};

function flatten(node: MessageNode, prefix: string, out = new Map<string, string>()) {
  if (typeof node === 'string') {
    out.set(prefix, node);
    return out;
  }
  for (const [key, child] of Object.entries(node)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function vaultCatalog(locale: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const namespace of VAULT_NAMESPACES) {
    flatten(locale[namespace] as MessageNode, namespace, out);
  }
  return out;
}

function placeholders(value: string): string[] {
  return (value.match(/\{\{\w+\}\}/g) ?? []).slice().sort();
}

const deVault = vaultCatalog(de as unknown as Record<string, unknown>);
const enVault = vaultCatalog(en as unknown as Record<string, unknown>);

describe('the vault catalogs are structurally paired (EN ⇄ DE)', () => {
  test('catches a newly added vault-NAMED root, and lists nothing the catalog lacks', () => {
    const governed = new Set<string>(VAULT_NAMESPACES);
    // A name heuristic, deliberately not called exhaustive — see the note on
    // VAULT_NAMESPACES. It closes the common hole (somebody adds `vaultFoo`)
    // and says nothing about a paranoid surface named something else.
    const vaultNamed = Object.keys(en).filter((key) => /vault|paranoid/i.test(key));
    expect(vaultNamed.filter((key) => !governed.has(key))).toEqual([]);
    // …and nothing is listed that the catalog does not actually define, so a
    // renamed root fails here instead of silently dropping out of scope.
    expect([...governed].filter((key) => !(key in en))).toEqual([]);
  });

  test('every EN vault key has a DE twin, and no DE key is an orphan', () => {
    const missing = [...enVault.keys()].filter((key) => !deVault.has(key));
    const orphan = [...deVault.keys()].filter((key) => !enVault.has(key));
    expect(missing, `missing in de: ${missing.join(', ')}`).toEqual([]);
    expect(orphan, `orphan in de: ${orphan.join(', ')}`).toEqual([]);
  });

  test('every {{placeholder}} survives translation, as a multiset per key', () => {
    const drifted: string[] = [];
    for (const [key, source] of enVault) {
      const translated = deVault.get(key);
      if (translated === undefined) continue;
      const left = placeholders(source);
      const right = placeholders(translated);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        drifted.push(`${key} (en: [${left.join(', ')}] / de: [${right.join(', ')}])`);
      }
    }
    expect(drifted, `placeholder drift:\n  ${drifted.join('\n  ')}`).toEqual([]);
  });
});

describe('German per-vault translations', () => {
  test('the formal-address probe is not vacuous', () => {
    expect(FORMAL_ADDRESS.test('Bitte geben Sie Ihre Passphrase ein.')).toBe(true);
    expect(FORMAL_ADDRESS.test('Bitte gib deine Passphrase ein.')).toBe(false);
    // …and the scan reaches the real catalog rather than an empty tree.
    expect(deVault.size).toBeGreaterThan(200);
    expect(deVault.get('vault.unlock.title')).toBeTypeOf('string');
  });

  test('keep the whole vault UX informal and calm', () => {
    const formal = [...deVault]
      .filter(([key, value]) => FORMAL_ADDRESS.test(value) && NOT_FORMAL_ADDRESS[key] !== value)
      .map(([key, value]) => `${key}: ${value}`);
    expect(formal, `formal address in:\n  ${formal.join('\n  ')}`).toEqual([]);

    expect(de.vault.manager.explainer.names).toBe(
      'Tresornamen und Speichereinstellungen bleiben lesbar, damit BetterTrack sie auch gesperrt anzeigen und zuordnen kann.',
    );
    expect(de.vault.portfolioMove.moveOut.confirm).toContain('für den Server wieder lesbar');
  });

  test('every tone exception still exists, still reads as written, and is still needed', () => {
    for (const [key, value] of Object.entries(NOT_FORMAL_ADDRESS)) {
      expect(deVault.get(key), `${key} no longer carries the pinned text`).toBe(value);
      expect(FORMAL_ADDRESS.test(value), `${key} no longer needs an exception`).toBe(true);
    }
  });

  test('keeps the security-sensitive placeholders intact', () => {
    expect(de.vault.creation.step).toBe('Schritt {{current}} von {{total}}');
    expect(de.vault.creation.verifyLabel).toBe('Wort {{word}}');
    expect(de.vault.sync.aggregate.attention).toContain('{{name}}');
    expect(de.vault.lockedStub.count).toContain('{{count}}');
  });
});
