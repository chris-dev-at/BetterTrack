import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';

import { API_KEY_SCOPES, type ApiKeyScope } from '@bettertrack/contracts';

import { ScopePicker, ScopeSummary } from './ScopePicker';

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
}: {
  initial?: readonly ApiKeyScope[];
  onLastValue?: (scopes: ApiKeyScope[]) => void;
}) {
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(initial ?? []));
  return (
    <ScopePicker
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
      'Workboard',
      'Market',
      'Social',
      'Notifications',
      'Chat',
      'Alerts',
      'Account security',
    ]) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    // The read/write column labels appear as visible text.
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Write').length).toBeGreaterThan(0);
    // 6 modules with read+write (12) + market (read only, 1) + account
    // security (single Access toggle, 1) = 14. Verbose descriptions are gone
    // — the row IS the module now.
    expect(screen.getAllByRole('checkbox').length).toBe(14);
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
      /workboard · write/i,
      /social · write/i,
      /notifications · write/i,
      /chat · write/i,
      /alerts · write/i,
    ];
    for (const rx of writes) {
      await user.click(screen.getByRole('checkbox', { name: rx }));
    }
    await user.click(screen.getByRole('checkbox', { name: /market · read/i }));
    await user.click(screen.getByRole('checkbox', { name: /account security · access/i }));

    const last = seen[seen.length - 1]!;
    // Full API_KEY_SCOPES taxonomy — no invented strings, no missing ones.
    expect(new Set(last)).toEqual(new Set(API_KEY_SCOPES));
  });

  test('Market has no Write half and Account security is a single combined toggle', () => {
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
  });

  test('info-point reveals the module description on demand — not by default', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    // Not shown yet — verbose descriptions moved into info-points, per the
    // anti-bloat rule.
    expect(
      screen.queryByText(/read your portfolios, holdings and cash balances/i),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more info about portfolio/i }));
    expect(
      screen.getByText(/read your portfolios, holdings and cash balances/i),
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
    expect(screen.getAllByRole('checkbox').length).toBe(14);
  });
});

describe('ScopeSummary', () => {
  test('groups requested scopes by module in the canonical order (Portfolio → Social → Market → …)', () => {
    // Deliberately out-of-order + across modules to prove the grouping.
    render(
      <ScopeSummary
        items={[
          { scope: 'social:read', label: 'See your friends and the items shared with you' },
          {
            scope: 'portfolio:write',
            label: 'Create and edit portfolios, transactions, custom assets and cash',
          },
          {
            scope: 'portfolio:read',
            label: 'View your portfolios, holdings, transactions and cash balances',
          },
          { scope: 'market:read', label: 'Search assets and read market data' },
        ]}
      />,
    );

    // Every module row surfaces its plain-language claim(s) under the module label.
    const portfolio = screen.getByText('Portfolio').closest('li')!;
    expect(
      within(portfolio).getByText('View your portfolios, holdings, transactions and cash balances'),
    ).toBeInTheDocument();
    expect(
      within(portfolio).getByText(
        'Create and edit portfolios, transactions, custom assets and cash',
      ),
    ).toBeInTheDocument();

    const market = screen.getByText('Market').closest('li')!;
    expect(within(market).getByText('Search assets and read market data')).toBeInTheDocument();

    const social = screen.getByText('Social').closest('li')!;
    expect(
      within(social).getByText('See your friends and the items shared with you'),
    ).toBeInTheDocument();

    // Modules with no requested scopes stay hidden.
    expect(screen.queryByText('Workboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
  });
});
