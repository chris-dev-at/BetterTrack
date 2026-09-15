import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { EndpointVaultState } from '../keystore';

import { PortfolioVaultMoveWizard } from './PortfolioVaultMoveWizard';
import { VaultCreationCeremony } from './VaultCreationCeremony';
import { VaultRestorePicker } from './VaultRestorePicker';
import { VaultStateAction } from './VaultStateAction';

/**
 * The design pass, asserted at the markup the owner actually sees.
 *
 * `originConversion.test.ts` is the negative half — no `bt-link`, no raw
 * radio/checkbox/`<details>` anywhere under `vault/ui`. This is the positive
 * half: each converted surface really RENDERS the Origin primitive, so a
 * refactor that quietly drops back to a bare `<span>` fails here even though it
 * introduces none of the banned patterns.
 *
 * Every assertion also pins the property that made the conversion safe: a route
 * stays a route (`role="link"` + `href`), and a choice stays a native radio.
 */
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const VAULT_ID = '018f0000-0000-7000-8000-000000000001';

const NEEDS_PHRASE: EndpointVaultState = {
  status: 'not-on-this-endpoint',
  requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
};

describe('VaultStateAction', () => {
  it('renders the deep link as a button-skinned route, never a bare anchor', () => {
    const { container } = render(
      <MemoryRouter>
        <VaultStateAction state={NEEDS_PHRASE} vaultId={VAULT_ID} />
      </MemoryRouter>,
    );

    const enterWords = screen.getByRole('link', { name: 'Enter words' });
    // The skin is Origin's button…
    expect(enterWords).toHaveClass('bt-btn', 'bt-btn--sm');
    // …and the semantics are still a link, which is why middle-click,
    // open-in-new-tab and the settings deep link all survived the pass.
    expect(enterWords.tagName).toBe('A');
    expect(enterWords).toHaveAttribute(
      'href',
      `/control/privacy?vault=${VAULT_ID}&action=provide-phrase`,
    );
    expect(container.querySelector('.bt-link')).toBeNull();
  });

  it('gives the manager row exactly one primary affordance', () => {
    render(
      <MemoryRouter>
        <VaultStateAction emphasis="primary" state={NEEDS_PHRASE} vaultId={VAULT_ID} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Enter words' })).toHaveClass('bt-btn--primary');
    // The second affordance of the same state stays secondary — "one primary".
    expect(screen.getByRole('link', { name: 'Scan QR' })).toHaveClass('bt-btn--quiet');
  });
});

describe('VaultCreationCeremony', () => {
  function renderCeremony() {
    return render(
      <VaultCreationCeremony
        challengeFactory={() => ({ wordNumber: 12 })}
        connections={[]}
        onCancel={() => {}}
        onCreate={vi.fn(async () => undefined)}
        onCreated={() => {}}
        phraseFactory={() => PHRASE}
      />,
    );
  }

  it('wears the wizards’ own dot stepper', () => {
    const { container } = renderCeremony();

    const stepper = container.querySelector('.bt-pfw__stepper');
    expect(stepper).not.toBeNull();
    expect(container.querySelectorAll('.bt-pfw__dot')).toHaveLength(6);
    expect(container.querySelector('.bt-pfw__dot[data-state="current"]')).not.toBeNull();
    // The dots are decoration; the position is stated in text for everyone else.
    expect(container.querySelector('.bt-pfw__dots')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
  });

  it('renders the storage options as one ruled choice group, not a card each', async () => {
    const user = userEvent.setup();
    const { container } = renderCeremony();
    await user.type(screen.getByLabelText('Vault name'), 'Long-term');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // One group, three rows — the house rule ("hairline-ruled rows instead of a
    // card per option"), not three `bt-panel` boxes.
    expect(container.querySelectorAll('.bt-choices')).toHaveLength(1);
    expect(container.querySelectorAll('.bt-choice')).toHaveLength(3);
    expect(container.querySelector('.bt-choices')).toHaveAttribute('role', 'radiogroup');
    // The control inside is still the platform's radio.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(container.querySelector('.bt-choice.is-selected')).not.toBeNull();
    // A medium this build refuses is muted and explained in place.
    expect(container.querySelectorAll('.bt-choice--muted')).toHaveLength(2);
    expect(container.querySelectorAll('.bt-choice__note')).toHaveLength(2);
  });

  it('shows BOTH custody options, the risky one de-emphasised rather than hidden', async () => {
    const user = userEvent.setup();
    const { container } = renderCeremony();

    await user.type(screen.getByLabelText('Vault name'), 'Long-term');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'I stored the words' }));
    await user.type(screen.getByLabelText('Word 12'), 'about');
    await user.click(screen.getByRole('button', { name: 'Verify word' }));

    // Step 5's acknowledgment is a CheckRow, not a tick beside a sentence.
    expect(container.querySelector('.bt-check--gold')).not.toBeNull();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 6: the unwrapped option used to sit behind `<details>`. It is on the
    // page now — muted, badged "Advanced device custody", never concealed.
    const choices = screen.getAllByRole('radio');
    expect(choices).toHaveLength(2);
    expect(container.querySelector('.bt-disclosure')).toBeNull();
    const plain = container.querySelectorAll('.bt-choice--muted');
    expect(plain).toHaveLength(1);
    expect(plain[0]).toHaveTextContent('Advanced device custody');
    expect(plain[0]?.querySelector('.bt-badge')).not.toBeNull();
  });
});

describe('VaultRestorePicker', () => {
  it('badges each copy’s status and keeps a corrupt one visible but inert', () => {
    const { container } = render(
      <VaultRestorePicker
        candidates={[
          {
            id: 'good',
            source: 'server-history',
            medium: 'server',
            envelope: new Uint8Array([1]),
            version: 2,
            updatedAt: '2026-08-20T10:00:00.000Z',
            status: 'available',
          },
          {
            id: 'bad',
            source: 'server-history',
            medium: 'server',
            envelope: new Uint8Array([2]),
            version: 1,
            updatedAt: '2026-08-19T10:00:00.000Z',
            status: 'corrupt',
          },
        ]}
        onRestore={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.bt-choice')).toHaveLength(2);
    expect(screen.getByText('Available')).toHaveClass('bt-badge', 'bt-badge--pos');
    expect(screen.getByText('Corrupt — cannot restore')).toHaveClass('bt-badge', 'bt-badge--neg');
    expect(screen.getAllByRole('radio')[1]).toBeDisabled();
  });
});

describe('PortfolioVaultMoveWizard', () => {
  it('renders unmet preconditions as a badged checklist with one action each', () => {
    const { container } = render(
      <MemoryRouter>
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={() => {}}
          onSubmit={vi.fn(async () => undefined)}
          portfolioName="Daily"
          preconditions={[
            {
              id: 'mirrorchain',
              messageKey: 'vault.portfolioMove.precondition.mirrorchain',
              fixLabelKey: 'vault.portfolioMove.precondition.mirrorchainFix',
              fixHref: '/portfolio/settings',
            },
            {
              // No fix: the row still states the blocker and offers nothing,
              // rather than becoming a link that leads nowhere.
              id: 'captureUnavailable',
              messageKey: 'vault.portfolioMove.precondition.captureUnavailable',
            },
          ]}
          vaults={[{ id: VAULT_ID, name: 'Private' }]}
        />
      </MemoryRouter>,
    );

    const rows = container.querySelectorAll('.bt-panel');
    // The wizard's own section is a panel too; the two checklist rows are the
    // ones carrying a "Needed" badge.
    const badges = screen.getAllByText('Needed');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveClass('bt-badge', 'bt-badge--neg');
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const fix = screen.getByRole('link', { name: 'Open group settings' });
    expect(fix).toHaveClass('bt-btn');
    expect(fix).toHaveAttribute('href', '/portfolio/settings');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(container.querySelector('.bt-link')).toBeNull();
  });

  it('makes the move-out consent a CheckRow that still gates the commit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const { container } = render(
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

    const consent = container.querySelector('.bt-check');
    expect(consent).not.toBeNull();
    expect(consent).toHaveClass('bt-check--gold');
    expect(consent).not.toHaveClass('is-checked');

    const commit = screen.getByRole('button', { name: 'Restore as a normal portfolio' });
    expect(commit).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(container.querySelector('.bt-check')).toHaveClass('is-checked');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
