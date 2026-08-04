import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

import type { Idea, IdeaWorkboardState } from '@bettertrack/contracts';

vi.mock('../../lib/ideasApi', () => ({ createIdea: vi.fn() }));

import { createIdea } from '../../lib/ideasApi';
import { setViewportWidth } from '../../test/viewport';
import { SaveIdeaDialog } from './SaveIdeaDialog';

const STATE: IdeaWorkboardState = {
  source: { kind: 'adhoc', positions: [{ assetId: 'asset-1', weight: 100 }] },
  range: '5Y',
  benchmark: null,
  mode: 'clip',
  rebalance: 'none',
};

test('at 390 px creates an idea through the phone sheet', async () => {
  setViewportWidth(390);
  const idea: Idea = {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Mobile idea',
    thesis: 'Test the workflow.',
    state: STATE,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
  vi.mocked(createIdea).mockResolvedValue({ idea });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SaveIdeaDialog state={STATE} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(screen.getByRole('dialog', { name: 'Save as idea' })).toHaveClass(
    'bt-dialog__panel--phone-sheet',
  );
  await user.type(screen.getByLabelText('Name'), 'Mobile idea');
  await user.type(screen.getByLabelText('Thesis (optional)'), 'Test the workflow.');
  await user.click(screen.getByRole('button', { name: 'Save idea' }));

  await waitFor(() =>
    expect(createIdea).toHaveBeenCalledWith({
      name: 'Mobile idea',
      thesis: 'Test the workflow.',
      state: STATE,
    }),
  );
  expect(await screen.findByText('"Mobile idea" is in your Ideas list.')).toBeInTheDocument();
});
