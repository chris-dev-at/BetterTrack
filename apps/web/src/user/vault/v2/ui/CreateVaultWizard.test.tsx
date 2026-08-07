import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createVault: vi.fn(),
  writeVaultHeaderDoc: vi.fn(),
}));
vi.mock('../api', () => api);

import { CreateVaultWizard } from './CreateVaultWizard';
import { checkVaultPassphrase } from '../words';

function mount(onCreated = vi.fn()) {
  return {
    onCreated,
    ...render(
      <MemoryRouter>
        <CreateVaultWizard onClose={vi.fn()} onCreated={onCreated} open />
      </MemoryRouter>,
    ),
  };
}

/** Read the twelve generated words straight off the step-3 list. */
function shownWords(): string[] {
  const list = screen.getByRole('list', { name: 'Your twelve vault words' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.replace(/^\d+/u, '').trim() ?? '');
}

describe('CreateVaultWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createVault.mockImplementation((input: { id: string }) =>
      Promise.resolve({
        id: input.id,
        name: 'Drive vault',
        backends: ['drive'],
        createdAt: '2026-08-08T09:00:00.000Z',
        portfolioIds: [],
      }),
    );
    api.writeVaultHeaderDoc.mockResolvedValue({ status: 'ok', version: 1 });
  });

  it('walks name → backend → words → done and creates the vault', async () => {
    const user = userEvent.setup();
    const { onCreated } = mount();

    // Step 1 — name.
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByLabelText('Vault name'), 'Drive vault');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2 — backend.
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Google Drive only/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 3 — twelve generated words.
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    const words = shownWords();
    expect(words).toHaveLength(12);
    expect(checkVaultPassphrase(words.join(' ')).valid).toBe(true);

    const create = screen.getByRole('button', { name: 'Create vault' });
    expect(create).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    // Confirmation fields appear only after the user says they wrote them down.
    const fields = screen.getAllByLabelText(/^Word \d+$/u);
    expect(fields).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Create vault' })).toBeDisabled();

    for (const field of fields) {
      const position = Number(/\d+/u.exec(field.getAttribute('id') ?? '')?.[0] ?? '0');
      await user.type(field, words[position]!);
    }

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create vault' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    await waitFor(() => expect(api.createVault).toHaveBeenCalledTimes(1));
    const call = api.createVault.mock.calls[0]![0] as {
      id: string;
      name: string;
      backends: string[];
      header: { vaultId: string; seal: string | null; portfolios: unknown[] };
    };
    expect(call.name).toBe('Drive vault');
    expect(call.backends).toEqual(['drive']);
    // The header is built client-side, sealed, and bound to the id we minted.
    expect(call.header.vaultId).toBe(call.id);
    expect(call.header.seal).not.toBeNull();
    expect(call.header.portfolios).toEqual([]);

    expect(onCreated).toHaveBeenCalledWith(call.id, words.join(' '));
    await waitFor(() => expect(screen.getByText('Step 4 of 4')).toBeInTheDocument());
  });

  it('rejects a wrong confirmation word', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Vault name'), 'Drive vault');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));

    for (const field of screen.getAllByLabelText(/^Word \d+$/u)) {
      await user.type(field, 'wrongword');
    }
    expect(screen.getByRole('button', { name: 'Create vault' })).toBeDisabled();
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('generates a fresh phrase each time the words step is reached', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Vault name'), 'Drive vault');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const first = shownWords();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(shownWords()).not.toEqual(first);
  });

  it('refuses when the server hands back a different vault id', async () => {
    const user = userEvent.setup();
    api.createVault.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Drive vault',
      backends: ['drive'],
      createdAt: '2026-08-08T09:00:00.000Z',
      portfolioIds: [],
    });

    mount();
    await user.type(screen.getByLabelText('Vault name'), 'Drive vault');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const words = shownWords();
    await user.click(screen.getByRole('checkbox'));
    for (const field of screen.getAllByLabelText(/^Word \d+$/u)) {
      const position = Number(/\d+/u.exec(field.getAttribute('id') ?? '')?.[0] ?? '0');
      await user.type(field, words[position]!);
    }
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/different vault id/iu),
    );
    expect(screen.queryByText('Step 4 of 4')).not.toBeInTheDocument();
  });

  it('states the lost-words consequence on the same screen as the words', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Vault name'), 'Drive vault');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('note')).toHaveTextContent(/no reset and no recovery/iu);
  });
});
