import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VaultProvisionIncompleteError } from '../provisionErrors';
import { VaultCreationCeremony } from './VaultCreationCeremony';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('VaultCreationCeremony', () => {
  it('runs the exact six-step ceremony and keeps the phrase after a wrong word', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    const onCreated = vi.fn();
    render(
      <VaultCreationCeremony
        challengeFactory={() => ({ wordNumber: 12 })}
        connections={[]}
        onCancel={() => {}}
        onCreate={onCreate}
        onCreated={onCreated}
        phraseFactory={() => PHRASE}
      />,
    );

    await user.type(screen.getByLabelText('Vault name'), 'Long-term');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('radio', { name: /Encrypted on BetterTrack/i })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: 'I stored the words' }));
    expect(screen.getByLabelText('Word 12')).toBeInTheDocument();
    expect(screen.queryByLabelText('Word 1')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Word 12'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Verify word' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That word does not match');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('about')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I stored the words' }));
    await user.type(screen.getByLabelText('Word 12'), 'about');
    await user.click(screen.getByRole('button', { name: 'Verify word' }));

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText(/Forgetting this device password loses nothing/i)).toBeInTheDocument();
    expect(screen.getByText(/Losing this phone loses nothing/i)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByRole('radio', { name: /Protect the words with a device password/i }),
    ).toBeChecked();
    await user.type(screen.getByLabelText('Device password'), 'device-only-secret');
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Long-term',
        media: ['server'],
        mnemonic: PHRASE,
        custody: 'wrapped',
        devicePassword: 'device-only-secret',
      }),
    );
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('offers no Drive medium while per-vault Drive provisioning is absent', async () => {
    const user = userEvent.setup();
    render(
      <VaultCreationCeremony
        connections={[
          {
            id: '018f0000-0000-7000-8000-0000000000d1',
            googleSub: '123456789',
            email: 'owner@example.com',
            displayName: 'Personal',
            createdAt: '2026-08-20T09:00:00.000Z',
            lastVerifiedAt: '2026-08-20T10:00:00.000Z',
          },
        ]}
        onCancel={() => {}}
        onCreate={vi.fn(async () => undefined)}
        onCreated={() => {}}
        phraseFactory={() => PHRASE}
      />,
    );

    await user.type(screen.getByLabelText('Vault name'), 'Long-term');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // A choice `provisionVault` would refuse is never offered — and it says so
    // rather than sitting there inert.
    expect(screen.getByRole('radio', { name: /Google Drive only/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /BetterTrack \+ Google Drive/i })).toBeDisabled();
    expect(screen.getAllByText(/Drive storage for a new vault isn’t available yet/i)).toHaveLength(
      2,
    );
    expect(screen.getByRole('radio', { name: /Encrypted on BetterTrack/i })).toBeEnabled();
  });

  it('names the leftover vault when provisioning stopped after the row was created', async () => {
    const user = userEvent.setup();
    render(
      <VaultCreationCeremony
        challengeFactory={() => ({ wordNumber: 12 })}
        connections={[]}
        onCancel={() => {}}
        onCreate={vi.fn(async () => {
          throw new VaultProvisionIncompleteError('Long-term');
        })}
        onCreated={() => {}}
        phraseFactory={() => PHRASE}
      />,
    );

    await user.type(screen.getByLabelText('Vault name'), 'Long-term');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'I stored the words' }));
    await user.type(screen.getByLabelText('Word 12'), 'about');
    await user.click(screen.getByRole('button', { name: 'Verify word' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'device-only-secret');
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    // "Try again" would mint a SECOND vault, so the leftover is named instead.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Long-term');
    expect(alert).toHaveTextContent(/delete “Long-term” in the list below first/i);
    expect(alert).not.toHaveTextContent('No recovery step was skipped');
  });

  it('uses the supplied random single-word challenge without adding a delay gate', async () => {
    expect(VaultCreationCeremony.toString()).not.toMatch(/setTimeout|setInterval/);
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <VaultCreationCeremony
        challengeFactory={() => ({ wordNumber: 1 })}
        connections={[]}
        onCancel={() => {}}
        onCreate={onCreate}
        onCreated={() => {}}
        phraseFactory={() => PHRASE}
      />,
    );

    await user.type(screen.getByLabelText('Vault name'), 'Daily');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'I stored the words' }));
    expect(screen.getByLabelText('Word 1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Word 12')).not.toBeInTheDocument();
  });
});
