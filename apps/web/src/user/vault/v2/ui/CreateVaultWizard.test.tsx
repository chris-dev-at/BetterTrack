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

// Create vault runs the real code-wrap KDF (Argon2id, m=64MiB) inside
// buildVaultHeader — the tests deliberately keep it unmocked so the header
// round-trip stays honest. That work is CPU-bound and, under a loaded CI
// runner sharing cores across test files, comfortably exceeds vitest's 5s
// default. Raise the per-test budget for this file (and give the
// crypto-bound waitFors matching headroom below) so a slow KDF reads as
// slow, never as a failure.
vi.setConfig({ testTimeout: 20_000 });
const CRYPTO_WAIT = { timeout: 15_000 } as const;

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
        vault: {
          id: input.id,
          name: 'Drive vault',
          backends: 'drive',
          portfolioIds: [],
          portfolioCount: 0,
          createdAt: '2026-08-08T09:00:00.000Z',
          updatedAt: '2026-08-08T09:00:00.000Z',
        },
        header: null,
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

    // Step 2 — backend. Await the step transition (async re-render) before
    // querying it, or a loaded CI runner races the assertion.
    expect(await screen.findByText('Step 2 of 4')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Google Drive only/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 3 — twelve generated words.
    expect(await screen.findByText('Step 3 of 4')).toBeInTheDocument();
    const words = shownWords();
    expect(words).toHaveLength(12);
    expect(checkVaultPassphrase(words.join(' ')).valid).toBe(true);

    const create = screen.getByRole('button', { name: 'Create vault' });
    expect(create).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    // Confirmation fields appear only after the user says they wrote them down —
    // await their async appearance rather than querying synchronously.
    const fields = await screen.findAllByLabelText(/^Word \d+$/u);
    expect(fields).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Create vault' })).toBeDisabled();

    for (const field of fields) {
      const position = Number(/\d+/u.exec(field.getAttribute('id') ?? '')?.[0] ?? '0');
      await user.type(field, words[position]!);
    }

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create vault' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    await waitFor(() => expect(api.createVault).toHaveBeenCalledTimes(1), CRYPTO_WAIT);
    const call = api.createVault.mock.calls[0]![0] as {
      id: string;
      name: string;
      backends: string;
      header: { vaultId: string; seal: string | null; portfolios: unknown[] };
    };
    expect(call.name).toBe('Drive vault');
    expect(call.backends).toBe('drive');
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
    await user.click(await screen.findByRole('checkbox'));

    for (const field of await screen.findAllByLabelText(/^Word \d+$/u)) {
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
      vault: {
        id: '00000000-0000-4000-8000-000000000000',
        name: 'Drive vault',
        backends: 'drive',
        portfolioIds: [],
        portfolioCount: 0,
        createdAt: '2026-08-08T09:00:00.000Z',
        updatedAt: '2026-08-08T09:00:00.000Z',
      },
      header: null,
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

    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent(/different vault id/iu),
      CRYPTO_WAIT,
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
