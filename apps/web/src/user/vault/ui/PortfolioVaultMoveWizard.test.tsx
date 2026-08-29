import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { isDriveOnlyVaultMedia, PortfolioVaultMoveWizard } from './PortfolioVaultMoveWizard';

describe('PortfolioVaultMoveWizard', () => {
  it('gives every move-in precondition its own fix action and keeps commit blocked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={() => {}}
          onSubmit={onSubmit}
          portfolioName="Daily"
          preconditions={[
            {
              id: 'mirrorchain',
              messageKey: 'vault.portfolioMove.precondition.mirrorchain',
              fixLabelKey: 'vault.portfolioMove.precondition.mirrorchainFix',
              fixHref: '/portfolio/settings',
            },
            {
              id: 'import',
              messageKey: 'vault.portfolioMove.precondition.import',
              fixLabelKey: 'vault.portfolioMove.precondition.importFix',
              fixHref: '/portfolio/import',
            },
          ]}
          vaults={[
            { id: '018f0000-0000-7000-8000-000000000001', name: 'Private' },
            { id: '018f0000-0000-7000-8000-000000000002', name: 'Archive' },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Open group settings' })).toHaveAttribute(
      'href',
      '/portfolio/settings',
    );
    expect(screen.getByRole('link', { name: 'Open imports' })).toHaveAttribute(
      'href',
      '/portfolio/import',
    );
    await user.selectOptions(
      screen.getByLabelText('Target vault'),
      '018f0000-0000-7000-8000-000000000001',
    );
    expect(screen.getByText(/Those shares are not restored/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    expect(screen.getByRole('button', { name: 'Move into vault' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires both a target and step-up before move-in submits them together', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={() => {}}
          onSubmit={onSubmit}
          portfolioName="Daily"
          preconditions={[]}
          vaults={[{ id: '018f0000-0000-7000-8000-000000000001', name: 'Private' }]}
        />
      </MemoryRouter>,
    );

    const action = screen.getByRole('button', { name: 'Move into vault' });
    expect(action).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText('Target vault'),
      '018f0000-0000-7000-8000-000000000001',
    );
    expect(action).toBeDisabled();
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(action);

    expect(onSubmit).toHaveBeenCalledWith({
      vaultId: '018f0000-0000-7000-8000-000000000001',
      stepUp: { password: 'account-secret' },
    });
  });

  it('names the retained staging copy and its TTL only for a Drive-only target (#1491)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={() => {}}
          onSubmit={vi.fn(async () => undefined)}
          portfolioName="Daily"
          vaults={[
            { id: '018f0000-0000-7000-8000-000000000001', name: 'Private', driveOnly: false },
            { id: '018f0000-0000-7000-8000-000000000002', name: 'Drive vault', driveOnly: true },
          ]}
        />
      </MemoryRouter>,
    );

    const target = screen.getByLabelText('Target vault');
    await user.selectOptions(target, '018f0000-0000-7000-8000-000000000001');
    expect(screen.queryByText(/staging copy/i)).not.toBeInTheDocument();

    await user.selectOptions(target, '018f0000-0000-7000-8000-000000000002');
    // "up to", anchored at staging: `expires_at` is stamped when the copies are
    // staged, so the ceremony itself consumes part of the window and a flat
    // "for 10 minutes" would promise more recovery time than the user gets.
    expect(
      screen.getByText(/A short-lived encrypted staging copy stays on the BetterTrack server for/i),
    ).toHaveTextContent('for up to 10 minutes from when the copies are staged');
  });

  it('discloses the same retention on the move-out ceremony, which retains too (#1491)', async () => {
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          driveOnly
          mode="out"
          onCancel={() => {}}
          onSubmit={vi.fn(async () => undefined)}
          portfolioName="Daily"
          unlocked
          vaultName="Drive vault"
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/Its remaining documents stay on the BetterTrack server/i),
    ).toHaveTextContent('for up to 10 minutes from when the copies are staged');
  });

  it('does not claim a retention the server-backed move-out never creates', () => {
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="out"
          onCancel={() => {}}
          onSubmit={vi.fn(async () => undefined)}
          portfolioName="Daily"
          unlocked
          vaultName="Private"
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/staging copy/i)).not.toBeInTheDocument();
  });

  it('reads Drive-only positively, so a future non-server medium never inherits the copy', () => {
    expect(isDriveOnlyVaultMedia(['drive'])).toBe(true);
    expect(isDriveOnlyVaultMedia(['drive', 'server'])).toBe(false);
    expect(isDriveOnlyVaultMedia(['server'])).toBe(false);
    // The reserved medium: not Drive-only, and `!media.includes('server')` would
    // have said it was.
    expect(isDriveOnlyVaultMedia(['local'])).toBe(false);
  });

  it('states that move-out is server-readable again and refuses missing step-up', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="out"
          onCancel={() => {}}
          onSubmit={onSubmit}
          portfolioName="Daily"
          unlocked
          vaultName="Private"
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/server-readable again/i)).not.toHaveLength(0);
    const action = screen.getByRole('button', { name: 'Restore as a normal portfolio' });
    expect(action).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: /portfolio becomes server-readable again/i,
      }),
    );
    expect(action).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Confirmation method'), 'code');
    await user.type(screen.getByLabelText('Account confirmation'), '123456');
    expect(action).toBeEnabled();
    await user.click(action);
    expect(onSubmit).toHaveBeenCalledWith({ stepUp: { code: '123456' } });
  });
});
