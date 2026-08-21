import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
