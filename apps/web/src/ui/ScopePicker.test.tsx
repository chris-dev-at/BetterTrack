import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';

import {
  API_KEY_SCOPES,
  OAUTH_SCOPE_CAPABILITY_CLAIMS,
  OAUTH_SCOPE_LABELS,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { I18nProvider, localizedMessage } from '../i18n';
import { oauthScopeDescriptionKey } from '../lib/oauthScopeCopy';
import { isParanoidBlockedScope, ScopePicker, ScopeSummary, scopeModuleKey } from './ScopePicker';

/**
 * V5-P0b — the shared scope picker must:
 *   1. render ONE row per module (Portfolio, Social, …) instead of a wall of
 *      per-scope checkboxes;
 *   2. auto-select and lock READ when its module's WRITE is ticked (#371);
 *   3. emit the same scope strings the flat picker used to — zero contract
 *      shift.
 * The consent-side {@link ScopeSummary} groups a requested set by module for
 * plain-language display.
 */

/** Uncontrolled harness: matches how real callers (both the user and admin
 * forms) hold the picker state, so scope transitions run through the same
 * onChange contract callers rely on. */
function PickerHarness({
  initial,
  onLastValue,
  paranoid = false,
}: {
  initial?: readonly ApiKeyScope[];
  onLastValue?: (scopes: ApiKeyScope[]) => void;
  paranoid?: boolean;
}) {
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(initial ?? []));
  return (
    <ScopePicker
      paranoid={paranoid}
      scopes={scopes}
      onChange={(next) => {
        setScopes(next);
        onLastValue?.([...next]);
      }}
    />
  );
}

describe('ScopePicker', () => {
  test('renders one row per module — never a per-scope wall of checkboxes', () => {
    render(<PickerHarness />);
    // Every module label surfaces exactly once.
    for (const label of [
      'Portfolio',
      'Workbench',
      'Market',
      'Social',
      'Notifications',
      'Chat',
      'Alerts',
      'Cash',
      'Group portfolios',
      'Vault sync',
      'Account security',
      'Feedback',
    ]) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    // The read/write column labels appear as visible text.
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Write').length).toBeGreaterThan(0);
    // 9 modules with read+write (18) + market (read only, 1) + vault sync and
    // account security (one Access toggle each, 2) = 21. Verbose descriptions
    // are gone — the row IS the module now.
    expect(screen.getAllByRole('checkbox').length).toBe(21);
  });

  test('ticking Write auto-ticks and locks Read (#371 — write implies read)', async () => {
    const user = userEvent.setup();
    const seen: ApiKeyScope[][] = [];
    render(<PickerHarness onLastValue={(s) => seen.push(s)} />);

    await user.click(screen.getByRole('checkbox', { name: /portfolio · write/i }));

    const readBox = screen.getByRole('checkbox', { name: /portfolio · read/i });
    expect(readBox).toBeChecked();
    expect(readBox).toBeDisabled();

    // Emitted set carries BOTH the write and the implied read — byte-identical
    // to what the old flat picker sent to the API for the same intent.
    const last = seen[seen.length - 1]!;
    expect(new Set(last)).toEqual(new Set<ApiKeyScope>(['portfolio:read', 'portfolio:write']));
  });

  test('unticking a locked Read is a no-op — the write still implies it', async () => {
    const user = userEvent.setup();
    const seen: ApiKeyScope[][] = [];
    render(<PickerHarness onLastValue={(s) => seen.push(s)} />);

    await user.click(screen.getByRole('checkbox', { name: /portfolio · write/i }));
    const readBox = screen.getByRole('checkbox', { name: /portfolio · read/i });

    // The click is a no-op because the checkbox is disabled. userEvent.click
    // ignores disabled controls, matching the browser behavior.
    await user.click(readBox);
    expect(readBox).toBeChecked();
    expect(readBox).toBeDisabled();

    // No spurious "write dropped read" emission — the last observed value is
    // the one from the initial write click.
    const last = seen[seen.length - 1]!;
    expect(new Set(last)).toEqual(new Set<ApiKeyScope>(['portfolio:read', 'portfolio:write']));
  });

  test('emitted scope strings are byte-identical to the #371 taxonomy', async () => {
    const user = userEvent.setup();
    const seen: ApiKeyScope[][] = [];
    render(<PickerHarness onLastValue={(s) => seen.push(s)} />);

    // Tick every module's write (or combined) — the resulting set covers every
    // write scope + its implied read, i.e. every string in API_KEY_SCOPES.
    const writes = [
      /portfolio · write/i,
      /workbench · write/i,
      /social · write/i,
      /notifications · write/i,
      /chat · write/i,
      /alerts · write/i,
      /cash · write/i,
      /group portfolios · write/i,
      /feedback · write/i,
    ];
    for (const rx of writes) {
      await user.click(screen.getByRole('checkbox', { name: rx }));
    }
    await user.click(screen.getByRole('checkbox', { name: /market · read/i }));
    await user.click(screen.getByRole('checkbox', { name: /vault sync · access/i }));
    await user.click(screen.getByRole('checkbox', { name: /account security · access/i }));

    const last = seen[seen.length - 1]!;
    // Full API_KEY_SCOPES taxonomy — no invented strings, no missing ones.
    expect(new Set(last)).toEqual(new Set(API_KEY_SCOPES));
  });

  test('single-half modules and combined scopes render only their real capability', () => {
    render(<PickerHarness />);
    // Market: read only, no write.
    expect(screen.queryByRole('checkbox', { name: /market · write/i })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /market · read/i })).toBeInTheDocument();
    // Account security: single combined Access toggle, no r/w split.
    expect(
      screen.queryByRole('checkbox', { name: /account security · read/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /account security · write/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /account security · access/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /vault sync · access/i })).toBeInTheDocument();
    // Feedback exposes caller-owned history plus capture as a normal r/w pair.
    expect(screen.getByRole('checkbox', { name: /feedback · read/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /feedback · write/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /feedback · access/i })).not.toBeInTheDocument();
  });

  test('removes server-portfolio grants entirely for a paranoid account', () => {
    render(
      <PickerHarness
        paranoid
        initial={[
          'portfolio:read',
          'portfolio:write',
          'cash:read',
          'cash:write',
          'mirrorchain:read',
          'mirrorchain:write',
          'market:read',
          'vault:sync',
        ]}
      />,
    );

    expect(screen.queryByText('Portfolio')).not.toBeInTheDocument();
    expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    expect(screen.queryByText('Group portfolios')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /portfolio · read/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /cash · read/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /group portfolios · read/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /market · read/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /vault sync · access/i })).toBeChecked();
  });

  test('pins the paranoid blocked-scope set while preserving ciphertext sync', () => {
    for (const scope of [
      'portfolio:read',
      'portfolio:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
    ] as const) {
      expect(isParanoidBlockedScope(scope), scope).toBe(true);
    }
    expect(isParanoidBlockedScope('vault:sync')).toBe(false);
  });

  test('info-point reveals the module description on demand — not by default', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    // Not shown yet — verbose descriptions moved into info-points, per the
    // anti-bloat rule.
    expect(
      screen.queryByText(
        /read your portfolios, holdings, cash balances and the dividend, earnings and news feeds/i,
      ),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more info about portfolio/i }));
    expect(
      screen.getByText(
        /read your portfolios, holdings, cash balances and the dividend, earnings and news feeds/i,
      ),
    ).toBeInTheDocument();
  });

  test('collapsible mode starts closed by default — no scrolling through unrelated ticks', () => {
    const { container } = render(
      <ScopePicker
        scopes={new Set(['portfolio:read', 'portfolio:write'])}
        onChange={() => {}}
        collapsible
      />,
    );
    // The native <details> wrapper is rendered closed — the browser will
    // display:none its non-summary children, no scrolling past unrelated ticks.
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    // Header still shows a "2 selected" count so the user knows something's set.
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
  });

  test('collapsible mode with defaultOpen renders the module rows immediately', () => {
    const { container } = render(
      <ScopePicker scopes={new Set()} onChange={() => {}} collapsible defaultOpen />,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(true);
    expect(screen.getAllByRole('checkbox').length).toBe(21);
  });
});

/**
 * #1860 — the German half of the consent-copy guard. `apps/api` binds each
 * {@link OAUTH_SCOPE_CAPABILITY_CLAIMS} entry to the routes that grant it and to
 * the English phrase; this map is the DE counterpart, and the test below fails
 * if a claim has no entry here. A new capability therefore cannot ship in one
 * locale only.
 */
const GERMAN_CAPABILITY_PHRASES: Readonly<Record<string, string>> = {
  'mirrorchain.delete-chain': 'ein Gruppenportfolio löschen',
  'mirrorchain.transfer-ownership': 'die Eigentümerschaft übertragen',
  'mirrorchain.manage-members': 'Mitglieder einladen, befördern und entfernen',
  'account-security.delete-vault': 'einen Tresor endgültig löschen',
  'account-security.portfolio-vault-move': 'Portfolios in einen Tresor verschieben',
  'account-security.delete-passkey': 'einen Passkey löschen',
  'account-security.revoke-grant': 'den Zugriff einer anderen App widerrufen',
  'portfolio.tax-regime': 'Steuerregime',
};

describe('consent copy names what the scope really grants (#1860)', () => {
  test('every capability the API binds to a scope is named in EN and DE, on the scope line and in its module info-point', () => {
    for (const claim of OAUTH_SCOPE_CAPABILITY_CLAIMS) {
      const german = GERMAN_CAPABILITY_PHRASES[claim.id];
      // A claim without German copy is a half-shipped widening — EN + DE move
      // together or neither moves.
      expect(german, `missing German phrase for ${claim.id}`).toBeTruthy();

      const moduleKey = scopeModuleKey(claim.scope);
      for (const [locale, phrase] of [
        ['en', claim.enPhrase],
        ['de', german!],
      ] as const) {
        const scopeLine = localizedMessage(locale, oauthScopeDescriptionKey(claim.scope));
        const moduleInfo = localizedMessage(
          locale,
          `ui.scopePicker.module.${moduleKey}.description`,
        );
        expect(scopeLine.toLowerCase(), `${locale} scope line: ${claim.id}`).toContain(
          phrase.toLowerCase(),
        );
        expect(moduleInfo.toLowerCase(), `${locale} module info: ${claim.id}`).toContain(
          phrase.toLowerCase(),
        );
      }
    }
  });

  test('the picker bundle stays in step with the server-rendered English label', () => {
    // Kept as a DRIFT check only — on its own it proves nothing about what a
    // scope grants, which is exactly how the three #1860 defects survived.
    for (const scope of API_KEY_SCOPES) {
      const key = oauthScopeDescriptionKey(scope);
      const english = localizedMessage('en', key);
      const german = localizedMessage('de', key);

      expect(english, `en: ${scope}`).toBe(OAUTH_SCOPE_LABELS[scope]);
      expect(german, `de: ${scope}`).not.toBe(english);
    }
  });
});

describe('ScopeSummary', () => {
  test('renders the corrected destructive-capability copy on the consent-side summary', () => {
    render(
      <ScopeSummary
        items={[
          { scope: 'mirrorchain:write', label: OAUTH_SCOPE_LABELS['mirrorchain:write'] },
          { scope: 'account:security', label: OAUTH_SCOPE_LABELS['account:security'] },
        ]}
      />,
    );

    const chain = screen.getByText('Group portfolios').closest('li')!;
    expect(within(chain).getByText(/delete a group portfolio/i)).toBeInTheDocument();
    expect(within(chain).getByText(/transfer ownership/i)).toBeInTheDocument();
    const security = screen.getByText('Account security').closest('li')!;
    expect(within(security).getByText(/permanently deleting a vault/i)).toBeInTheDocument();
  });

  test('localizes feedback consent copy from its scope id instead of the server English label', () => {
    render(
      <I18nProvider initialLocale="de">
        <ScopeSummary
          items={[{ scope: 'feedback:write', label: OAUTH_SCOPE_LABELS['feedback:write'] }]}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByText('Feedback, Funktionswünsche und Fehlerberichte in deinem Namen senden'),
    ).toBeInTheDocument();
    expect(screen.queryByText(OAUTH_SCOPE_LABELS['feedback:write'])).not.toBeInTheDocument();
  });

  test('groups requested scopes by module in the canonical order (Portfolio → Social → Market → …)', () => {
    // Deliberately out-of-order + across modules to prove the grouping.
    render(
      <ScopeSummary
        items={[
          { scope: 'social:read', label: 'See your friends and the items shared with you' },
          {
            scope: 'portfolio:write',
            label: OAUTH_SCOPE_LABELS['portfolio:write'],
          },
          {
            scope: 'portfolio:read',
            label:
              'View your portfolios, holdings, transactions, cash balances and the dividend, earnings and news feeds derived from them',
          },
          { scope: 'market:read', label: 'Search assets and read market data' },
        ]}
      />,
    );

    // Every module row surfaces its plain-language claim(s) under the module label.
    const portfolio = screen.getByText('Portfolio').closest('li')!;
    expect(
      within(portfolio).getByText(
        'View your portfolios, holdings, transactions, cash balances and the dividend, earnings and news feeds derived from them',
      ),
    ).toBeInTheDocument();
    expect(within(portfolio).getByText(OAUTH_SCOPE_LABELS['portfolio:write'])).toBeInTheDocument();

    const market = screen.getByText('Market').closest('li')!;
    expect(within(market).getByText('Search assets and read market data')).toBeInTheDocument();

    const social = screen.getByText('Social').closest('li')!;
    expect(
      within(social).getByText('See your friends and the items shared with you'),
    ).toBeInTheDocument();

    // Modules with no requested scopes stay hidden.
    expect(screen.queryByText('Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
  });
});
