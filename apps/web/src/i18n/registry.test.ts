import { describe, expect, test } from 'vitest';

import {
  ADMIN_BACKUP_STATUS_LEVELS,
  ADMIN_BACKUP_STATUS_REASONS,
  FEEDBACK_STATUSES,
  NOTIFICATION_MESSAGE_KEYS,
  VAULT_MEDIA,
} from '@bettertrack/contracts';

import { notificationMessagePath } from '../lib/notificationText';
import { vaultStoreErrorKey } from '../user/vault/engine/errorCopy';
import { VAULT_AGGREGATE_SYNC_STATES, VAULT_MEDIUM_SYNC_STATES } from '../user/vault/media/status';
import {
  VAULT_TRANSFER_PAYLOAD_ERROR_OUTCOMES,
  VaultTransferPayloadError,
} from '../user/vault/qr/payload';
import { VAULT_ENABLE_STAGES } from '../user/vault/ui/enable';
import { payloadErrorKey } from '../user/vault/ui/VaultReceivePhrase';
import { VAULT_STATE_AFFORDANCES } from '../user/vault/vaultStateAffordance';
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

test('registers the submitter-facing helpdesk flow labels in EN and DE', () => {
  for (const locale of Object.values(LOCALES)) {
    for (const status of FEEDBACK_STATUSES) {
      const key = `feedback.status.${status}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
    for (const key of ['feedback.status.comingIn', 'feedback.status.declinedWithReason']) {
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }

  expect(localizedMessage('en', 'feedback.status.new')).toBe('Sent');
  expect(localizedMessage('en', 'feedback.status.triaged')).toBe('Read / in review');
  expect(localizedMessage('en', 'feedback.status.working_on_it')).toBe('In progress');
  expect(localizedMessage('en', 'feedback.status.saved_as_future_idea')).toBe(
    'On the waiting list',
  );
});

test('registers title/body copy for every dispatcher notification message key', () => {
  // The inbox renders `notificationContent.<key>.<part>` for every dispatcher
  // row (#1138). Read each catalog DIRECTLY rather than through
  // `localizedMessage`: that resolver falls back to EN, so a key missing only
  // its DE entry would still return a non-path string and pass. Comparing each
  // locale's pair against EN per key also keeps the guard honest for any number
  // of registered locales (the old slice pair compared two fixed halves).
  const translated = Object.values(LOCALES)
    .filter((l) => l.code !== 'en')
    .map((l) => [l.code, flatten(l.messages)] as const);

  for (const key of NOTIFICATION_MESSAGE_KEYS) {
    const paths = (['title', 'body'] as const).map((part) => notificationMessagePath(key, part));
    const enPair = paths.map((path) => {
      const value = enFlat.get(path);
      expect(value, `en: ${path} missing`).toBeTruthy();
      return value;
    });
    for (const [code, flat] of translated) {
      const pair = paths.map((path) => {
        const value = flat.get(path);
        expect(value, `${code}: ${path} missing`).toBeTruthy();
        return value;
      });
      expect(pair, `${key}: ${code} must not silently reuse EN`).not.toEqual(enPair);
    }
  }
});

test('uses one label for the Analysis and shared-items top-level surfaces in EN and DE', () => {
  for (const locale of ['en', 'de']) {
    const analysis = localizedMessage(locale, 'portfolio.tabs.analysis');
    expect(localizedMessage(locale, 'portfolio.analytics.title')).toBe(analysis);
    expect(localizedMessage(locale, 'portfolio.overview.chart.analyticsLink')).toBe(
      `${analysis} →`,
    );
    expect(localizedMessage(locale, 'social.myShared.title')).toBe(
      localizedMessage(locale, 'people.tabs.shared'),
    );
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

test('registers copy for every btvault transfer payload outcome in EN and DE', () => {
  // The scanner's only channel to the user is `payloadErrorKey`, and the
  // outcome vocabulary is a frozen cross-client contract — adding a member
  // (`malformed`, #1508) must not be able to land without its copy. Read each
  // catalog DIRECTLY rather than through `localizedMessage`: that resolver
  // falls back to EN, so an outcome missing only its DE entry would still
  // return a real sentence and pass. A key typo'd onto a *different* real key
  // resolves in both catalogs, so the uniqueness assertion is what catches it.
  const catalogs = Object.values(LOCALES).map((l) => [l.code, flatten(l.messages)] as const);
  expect(catalogs.map(([code]) => code)).toEqual(expect.arrayContaining(['en', 'de']));

  const keys = VAULT_TRANSFER_PAYLOAD_ERROR_OUTCOMES.map((outcome) => {
    const key = payloadErrorKey(new VaultTransferPayloadError(outcome));
    for (const [code, flat] of catalogs) {
      const value = flat.get(key);
      expect(typeof value, `${code}: ${outcome} -> ${key} does not resolve`).toBe('string');
      expect(value, `${code}: ${outcome} -> ${key} is blank`).not.toBe('');
    }
    return key;
  });

  expect(new Set(keys).size, `two outcomes share a key: ${keys.join(', ')}`).toBe(keys.length);
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

test('registers the portfolio move wizard and its server-readable warning in EN and DE', () => {
  const keys = [
    'vault.portfolioMove.stepUpHint',
    'vault.portfolioMove.moveIn.title',
    'vault.portfolioMove.moveIn.warning',
    'vault.portfolioMove.moveIn.action',
    'vault.portfolioMove.moveIn.working',
    'vault.portfolioMove.moveIn.done',
    'vault.portfolioMove.moveIn.error',
    'vault.portfolioMove.moveOut.title',
    'vault.portfolioMove.moveOut.unlockRequired',
    'vault.portfolioMove.moveOut.warning',
    'vault.portfolioMove.moveOut.confirm',
    'vault.portfolioMove.moveOut.action',
    'vault.portfolioMove.moveOut.working',
    'vault.portfolioMove.moveOut.done',
    'vault.portfolioMove.moveOut.error',
  ];
  for (const locale of Object.values(LOCALES)) {
    for (const key of keys) {
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }
  expect(localizedMessage('en', 'vault.portfolioMove.moveOut.warning')).toContain(
    'server-readable again',
  );
  expect(localizedMessage('de', 'vault.portfolioMove.moveOut.warning')).toContain(
    'für den BetterTrack-Server wieder lesbar',
  );
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
    for (const state of VAULT_AGGREGATE_SYNC_STATES) {
      for (const key of [
        `vault.sync.aggregate.${state}`,
        `vault.sync.aggregate.row.${state}`,
        `vault.sync.aggregate.rowState.${state}`,
      ]) {
        expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
      }
    }
    for (const affordance of Object.values(VAULT_STATE_AFFORDANCES)) {
      for (const key of [affordance.labelKey, affordance.stateKey]) {
        expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
      }
    }
    for (const key of [
      'vault.sync.aggregate.lockedOne',
      'vault.sync.aggregate.signInGoogle',
      'vault.sync.aggregate.openRestore',
      'vault.manager.action.scanQr',
      'vault.manager.access.restore',
    ]) {
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }
});

test('registers singular and plural locked-portfolio qualifiers in EN and DE', () => {
  for (const locale of Object.values(LOCALES)) {
    for (const suffix of ['One', 'Other']) {
      const key = `vaultComposition.lockedPortfoliosQualifier${suffix}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }

  expect(localizedMessage('en', 'vaultComposition.lockedPortfoliosQualifierOne')).toBe(
    '+ {{count}} locked portfolio',
  );
  expect(localizedMessage('en', 'vaultComposition.lockedPortfoliosQualifierOther')).toBe(
    '+ {{count}} locked portfolios',
  );
  expect(localizedMessage('de', 'vaultComposition.lockedPortfoliosQualifierOne')).toBe(
    '+ {{count}} gesperrtes Portfolio',
  );
  expect(localizedMessage('de', 'vaultComposition.lockedPortfoliosQualifierOther')).toBe(
    '+ {{count}} gesperrte Portfolios',
  );
});

test('registers singular and plural unreadable-portfolio qualifiers in EN and DE', () => {
  // #1514: a composed figure that excludes a corrupt member carries THIS
  // qualifier instead of the locked one. It is the only thing between the
  // reader and an unqualified subtotal, so a missing catalog entry would paint
  // a raw dot-path exactly where the honesty is supposed to be.
  for (const locale of Object.values(LOCALES)) {
    for (const suffix of ['One', 'Other']) {
      const key = `vaultComposition.unreadablePortfoliosQualifier${suffix}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }

  expect(localizedMessage('en', 'vaultComposition.unreadablePortfoliosQualifierOne')).toBe(
    '+ {{count}} unreadable portfolio',
  );
  expect(localizedMessage('de', 'vaultComposition.unreadablePortfoliosQualifierOther')).toBe(
    '+ {{count}} nicht lesbare Portfolios',
  );
});

test('registers backup readiness copy for every contract level and reason in EN and DE', () => {
  // The Overview tile and the Health panel both render
  // `admin.backup.level.<level>` and `admin.backup.reason.<reason>` as template
  // literals off the contract enums, so a member missing from BOTH catalogs is
  // parity-clean and would paint its raw dot-path at exactly the moment an
  // operator is trying to find out whether the backups are alive. Iterate the
  // contract tuples so the API's vocabulary and the catalogs stay bound.
  for (const locale of Object.values(LOCALES)) {
    for (const level of ADMIN_BACKUP_STATUS_LEVELS) {
      const key = `admin.backup.level.${level}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
    for (const reason of ADMIN_BACKUP_STATUS_REASONS) {
      const key = `admin.backup.reason.${reason}`;
      expect(localizedMessage(locale.code, key), `${locale.code}: ${key}`).not.toBe(key);
    }
  }
});

test('registers a localized unit for every duration magnitude in EN and DE', () => {
  // `formatDuration` picks one of these by magnitude; a missing member would
  // paint a dot-path where an uptime or a backup age belongs.
  for (const locale of Object.values(LOCALES)) {
    for (const unit of ['dayHour', 'hourMinute', 'minuteSecond', 'second']) {
      const key = `admin.common.duration.${unit}`;
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
    // #1491: the moment of the CHOICE may not make an absolute claim that the
    // staged-candidate retention then breaks — the exception and its TTL ship
    // inside the same string, in both locales.
    expect(localizedMessage(locale, 'vault.enable.media.driveOnly.body')).toMatch(
      locale === 'de' ? /Zwischenkopie/i : /staging copy/i,
    );
    expect(localizedMessage(locale, 'vault.enable.media.driveOnly.body')).toMatch(
      locale === 'de' ? /\{\{minutes\}\} Minuten/ : /\{\{minutes\}\} minutes/,
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

/**
 * V5-P8 counters. `t()` is plain token substitution — no pluralization — so a
 * counter that must read correctly at one AND many ships the repo's manual
 * one/other pair (`social.count.*` set the convention). A single "{{count}}
 * comments" string renders "1 comments" / "1 Kommentare".
 */
test('renders the V5-P8 counters with a singular and a plural form in EN and DE', () => {
  const cases = [
    {
      key: 'social.comments.count',
      en: ['1 comment', '2 comments'],
      de: ['1 Kommentar', '2 Kommentare'],
    },
    {
      key: 'social.groups.memberCount',
      en: ['1 member', '2 members'],
      de: ['1 Mitglied', '2 Mitglieder'],
    },
    {
      key: 'sharing.groupMemberCount',
      en: ['1 member', '2 members'],
      de: ['1 Mitglied', '2 Mitglieder'],
    },
  ] as const;

  for (const { key, en, de } of cases) {
    for (const [locale, expected] of [
      ['en', en],
      ['de', de],
    ] as const) {
      const one = localizedMessage(locale, `${key}.one`).replace('{{count}}', '1');
      const other = localizedMessage(locale, `${key}.other`).replace('{{count}}', '2');
      expect(one, `${locale}: ${key}.one`).not.toBe(`${key}.one`);
      expect(one).toBe(expected[0]);
      expect(other).toBe(expected[1]);
    }
  }
});
