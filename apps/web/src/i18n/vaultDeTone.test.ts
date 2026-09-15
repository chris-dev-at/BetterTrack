import { describe, expect, test } from 'vitest';

import de from './messages/de.json';

type MessageNode = string | { [key: string]: MessageNode };

function flattenStrings(node: MessageNode, values: string[] = []): string[] {
  if (typeof node === 'string') {
    values.push(node);
    return values;
  }
  for (const child of Object.values(node)) flattenStrings(child, values);
  return values;
}

describe('German per-vault translations', () => {
  test('keep the new vault UX informal and calm', () => {
    const formalAddress = /\b(?:Sie|Ihr|Ihnen|Ihren|Ihre|Ihrem|Ihres|Ihrer)\b/;
    const strings = flattenStrings({
      manager: de.vault.manager,
      creation: de.vault.creation,
      lockedStub: de.vault.lockedStub,
      portfolioMove: de.vault.portfolioMove,
      restorePicker: de.vault.restorePicker,
      aggregateSync: de.vault.sync.aggregate,
      // The in-place unlock is now the primary vault prompt app-wide, so it is
      // held to the same calm, informal register as the surfaces around it.
      unlockDialog: de.vault.unlockDialog,
    });

    expect(strings.filter((value) => formalAddress.test(value))).toEqual([]);
    expect(de.vault.manager.explainer.names).toBe(
      'Tresornamen und Speichereinstellungen bleiben lesbar, damit BetterTrack sie auch gesperrt anzeigen und zuordnen kann.',
    );
    expect(de.vault.portfolioMove.moveOut.confirm).toContain('für den Server wieder lesbar');
  });

  test('keeps the security-sensitive placeholders intact', () => {
    expect(de.vault.creation.step).toBe('Schritt {{current}} von {{total}}');
    expect(de.vault.creation.verifyLabel).toBe('Wort {{word}}');
    expect(de.vault.sync.aggregate.attention).toContain('{{name}}');
    expect(de.vault.lockedStub.count).toContain('{{count}}');
  });
});
