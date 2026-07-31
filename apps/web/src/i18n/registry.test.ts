import { describe, expect, test } from 'vitest';

import { VAULT_MEDIA } from '@bettertrack/contracts';

import { vaultStoreErrorKey } from '../user/vault/engine/errorCopy';
import { VAULT_MEDIUM_SYNC_STATES } from '../user/vault/media/status';
import { VAULT_ENABLE_STAGES } from '../user/vault/ui/enable';
import { VAULT_PORTFOLIO_STORE_ERROR_CODES } from '../user/vault/vaultPortfolioStore';
import { LOCALES, localizedMessage, type MessageNode } from './registry';

/**
 * Key-parity + placeholder-parity gate over the shipped catalogs
 * (§13.4 V4-P11 DE sweep, #528). EN is the source of truth; every non-default
 * locale MUST cover the same key set and preserve every `{{token}}` from the EN
 * source, or a translation is missing / a placeholder was dropped and the app
 * would render an untranslated string or a broken interpolation.
 */

function flatten(
  node: MessageNode,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(path, v);
    else if (v && typeof v === 'object') flatten(v as MessageNode, path, out);
  }
  return out;
}

function placeholders(str: string): string[] {
  return (str.match(/\{\{\w+\}\}/g) ?? []).slice().sort();
}

const enFlat = flatten(LOCALES.en.messages);
const nonDefaultLocales = Object.values(LOCALES).filter((l) => l.code !== 'en');

test('registers every not-found string in EN and DE', () => {
  const keys = [
    'notFound.title',
    'notFound.description',
    'notFound.requestedPath',
    'notFound.backToStart',
    'notFound.backToPrevious',
  ];

  for (const locale of Object.values(LOCALES)) {
    for (const key of keys) {
      expect(localizedMessage(locale.code, key)).not.toBe(key);
    }
  }
});

test('registers copy for every vault portfolio-store error code in EN and DE', () => {
  // The paranoid store fails closed by design; what it must never do is
  // surface a bare code like VAULT_OPERATION_UNAVAILABLE (#1016). Every code
  // maps to a key and every locale carries that key.
  for (const code of VAULT_PORTFOLIO_STORE_ERROR_CODES) {
    const key = vaultStoreErrorKey({ code });
    for (const locale of Object.values(LOCALES)) {
      expect(localizedMessage(locale.code, key)).not.toBe(key);
    }
  }
});

test('registers progress + error copy for every paranoid enable stage in EN and DE', () => {
  // `ParanoidEnableWizard` builds both keys with a template literal, so a stage
  // missing from BOTH catalogs is parity-clean and still paints its raw
  // dot-path — on the happy path of a one-way, irreversible flow. Iterate the
  // stage tuple instead so the union and the catalogs stay bound.
  for (const stage of VAULT_ENABLE_STAGES) {
    for (const locale of Object.values(LOCALES)) {
      for (const key of [`vault.enable.progress.${stage}`, `vault.enable.errors.${stage}`]) {
        expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
      }
    }
  }
});

test('registers status copy for every vault sync state and medium in EN and DE', () => {
  // Same blind spot as the enable stages: `VaultSyncChip` renders
  // `vault.sync.status.<state>` and `vault.sync.medium.<medium>` as template
  // literals — for the button label, its aria-label and every medium row — so a
  // member missing from BOTH catalogs is parity-clean and paints its dot-path.
  for (const locale of Object.values(LOCALES)) {
    for (const state of VAULT_MEDIUM_SYNC_STATES) {
      const key = `vault.sync.status.${state}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
    for (const medium of VAULT_MEDIA) {
      const key = `vault.sync.medium.${medium}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }
});

describe.each(nonDefaultLocales.map((l) => [l.code, l.messages] as const))(
  'catalog parity (en ⇄ %s)',
  (code, messages) => {
    const flat = flatten(messages);

    test(`${code}: covers every key en.json defines (no untranslated fallback)`, () => {
      const missing = [...enFlat.keys()].filter((k) => !flat.has(k));
      expect(missing, `missing in ${code}: ${missing.join(', ')}`).toEqual([]);
    });

    test(`${code}: introduces no orphan keys absent from en.json`, () => {
      const orphan = [...flat.keys()].filter((k) => !enFlat.has(k));
      expect(orphan, `orphan in ${code}: ${orphan.join(', ')}`).toEqual([]);
    });

    test(`${code}: preserves every {{placeholder}} the EN source uses`, () => {
      const drifted: string[] = [];
      for (const [key, en] of enFlat) {
        const translated = flat.get(key);
        if (translated === undefined) continue;
        const enPh = placeholders(en);
        const trPh = placeholders(translated);
        if (JSON.stringify(enPh) !== JSON.stringify(trPh)) {
          drifted.push(`${key} (en: [${enPh.join(', ')}] / ${code}: [${trPh.join(', ')}])`);
        }
      }
      expect(drifted, `placeholder drift in ${code}:\n  ${drifted.join('\n  ')}`).toEqual([]);
    });
  },
);

test('paranoid custody and destructive copy keeps the binding tone in EN and DE', () => {
  expect(localizedMessage('en', 'vault.enable.lostKeyAcknowledgment')).toBe(
    'If I lose my vault passphrase and my recovery kit, my data is gone forever. BetterTrack cannot recover it.',
  );
  expect(localizedMessage('de', 'vault.enable.lostKeyAcknowledgment')).toBe(
    'Wenn ich meine Tresor-Passphrase und mein Wiederherstellungspaket verliere, sind meine Daten für immer verloren. BetterTrack kann sie nicht wiederherstellen.',
  );

  for (const locale of ['en', 'de']) {
    expect(localizedMessage(locale, 'vault.enable.media.driveOnly.body')).toMatch(
      locale === 'de' ? /nicht einmal verschlüsselt/i : /not even encrypted/i,
    );
    expect(localizedMessage(locale, 'vault.settings.whatsOff')).toMatch(
      locale === 'de' ? /aus ist/i : /what.s off/i,
    );
    expect(localizedMessage(locale, 'vault.sync.needsAttention')).toMatch(
      locale === 'de' ? /Aufmerksamkeit/i : /needs attention/i,
    );
    expect(localizedMessage(locale, 'vault.settings.startFreshConfirm')).toMatch(
      locale === 'de' ? /dauerhaft ersetzt/i : /permanently replaced/i,
    );
    expect(localizedMessage(locale, 'vault.settings.disableConfirm')).toMatch(
      locale === 'de' ? /deaktivieren/i : /disable Paranoid mode/i,
    );
  }
});
