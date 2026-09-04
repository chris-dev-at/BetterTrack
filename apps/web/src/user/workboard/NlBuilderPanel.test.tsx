import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AiCapabilityResponse, AiConglomerateDraftResponse } from '@bettertrack/contracts';

vi.mock('../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(),
  draftConglomerate: vi.fn(),
}));

import { draftConglomerate, useAiCapability } from '../../lib/aiApi';
import type { BuilderPosition } from './conglomerateBuilder';
import { NlBuilderPanel } from './NlBuilderPanel';

const AVAILABLE: AiCapabilityResponse = {
  available: true,
  model: 'llama3.1:8b',
  dailyCap: 5,
  used: 0,
  remaining: 5,
};

const ASSET_ID = '00000000-0000-7000-8000-000000000001';

const DRAFT: AiConglomerateDraftResponse = {
  model: 'llama3.1:8b',
  lines: [
    {
      query: 'nasdaq',
      weightPct: 60,
      asset: { id: ASSET_ID, symbol: 'QQQ', name: 'Nasdaq 100', type: 'etf', currency: 'USD' },
    },
    { query: 'unicorn dust', weightPct: 40, asset: null },
  ],
};

function renderPanel(
  onApply: (positions: BuilderPosition[]) => void = vi.fn(),
  target: { name: string; positionCount: number } = { name: 'New blueprint', positionCount: 0 },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NlBuilderPanel
        onApply={onApply}
        targetName={target.name}
        targetPositionCount={target.positionCount}
      />
    </QueryClientProvider>,
  );
}

/** Type a description and ask for a draft — stops at the review step. */
async function draft(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox'), '60% nasdaq, 40% unicorn dust');
  await user.click(screen.getByRole('button', { name: 'Draft basket' }));
  await screen.findByRole('group', { name: 'Review the AI draft' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NlBuilderPanel', () => {
  test('renders NOTHING when the capability read says AI is unavailable (regression)', () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { ...AVAILABLE, available: false },
    } as never);
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  test('holds the draft for review — nothing reaches the Builder until the user applies', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderPanel(onApply);

    await draft(user);

    // The draft is on screen, and the Builder has NOT been handed anything yet —
    // no state the autosave could persist has changed (§6.5: always reviewed).
    expect(screen.getByText(/Draft ready: 1 positions/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply draft' }));

    // Only the RESOLVED line becomes a builder position; the weight is the model's,
    // the asset id comes from the catalog resolution.
    expect(onApply).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'asset', refId: ASSET_ID, symbol: 'QQQ', weightPct: 60 }),
    ]);
    expect(screen.getByText(/Prefilled 1 positions/)).toBeInTheDocument();
  });

  test('flags — never drops — unresolvable intents BEFORE the confirmation', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderPanel(onApply);

    await draft(user);

    const review = screen.getByRole('group', { name: 'Review the AI draft' });
    expect(review).toHaveTextContent('No catalog match');
    expect(review).toHaveTextContent('unicorn dust');
    expect(onApply).not.toHaveBeenCalled();
  });

  test('names what an apply would replace on an existing blueprint', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const user = userEvent.setup();
    renderPanel(vi.fn(), { name: 'My Basket', positionCount: 20 });

    await draft(user);

    expect(
      screen.getByText(/Applying replaces all 20 positions in .My Basket./),
    ).toBeInTheDocument();
  });

  test('discarding drops the draft without ever handing it to the Builder', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderPanel(onApply, { name: 'My Basket', positionCount: 20 });

    await draft(user);
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Review the AI draft' })).toBeNull(),
    );
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByText(/Prefilled/)).toBeNull();
  });

  test('carries the hard not-financial-advice framing and saves nothing itself', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText(/not financial advice/i)).toBeInTheDocument();

    await draft(user);

    expect(screen.getByText(/not financial advice/i)).toBeInTheDocument();
    // The only actions are draft/review — nothing that persists a conglomerate.
    expect(screen.queryByRole('button', { name: /save|activate|create/i })).toBeNull();
  });
});
