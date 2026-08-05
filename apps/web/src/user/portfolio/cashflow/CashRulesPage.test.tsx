import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CashRule, CashTag } from '@bettertrack/contracts';

vi.mock('../../../lib/cashApi', () => ({
  CASH_RULES_QUERY_KEY: ['cash', 'rules'],
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  listCashRules: vi.fn(),
  listCashTags: vi.fn(),
  createCashRule: vi.fn(),
  updateCashRule: vi.fn(),
  deleteCashRule: vi.fn(),
  applyCashRules: vi.fn(),
}));

import {
  applyCashRules,
  CASH_TAGS_QUERY_KEY,
  createCashRule,
  deleteCashRule,
  listCashRules,
  listCashTags,
} from '../../../lib/cashApi';
import { ApiError } from '../../../lib/apiClient';

import { CashRulesPage } from './CashRulesPage';

const FOOD: CashTag = {
  id: 't-food',
  name: 'Food',
  color: '#22c55e',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const GROCERIES: CashTag = { ...FOOD, id: 't-groceries', name: 'Groceries', color: '#3987e5' };

function rule(over: Partial<CashRule> = {}): CashRule {
  return {
    id: 'r1',
    tagIds: [FOOD.id],
    matchType: 'contains',
    pattern: 'REWE',
    priority: 0,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CashRulesPage />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCashTags).mockResolvedValue({ tags: [FOOD, GROCERIES] });
  vi.mocked(listCashRules).mockResolvedValue({ rules: [] });
});

describe('CashRulesPage', () => {
  test('renders every tag a rule applies as its own chip', async () => {
    vi.mocked(listCashRules).mockResolvedValue({
      rules: [rule({ tagIds: [FOOD.id, GROCERIES.id] })],
    });
    renderPage();

    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  test('creates a rule that assigns multiple tags at once', async () => {
    vi.mocked(createCashRule).mockResolvedValue({ rule: rule({ id: 'r-new' }) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog', { name: 'New rule' });
    await user.type(within(dialog).getByLabelText('Pattern'), 'REWE');
    await user.click(within(dialog).getByText('Food'));
    await user.click(within(dialog).getByText('Groceries'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(createCashRule).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: 'REWE',
        tagIds: expect.arrayContaining([FOOD.id, GROCERIES.id]),
      }),
    );
    expect(vi.mocked(createCashRule).mock.calls[0]![0].tagIds).toHaveLength(2);
  });

  test('blocks submission without at least one tag', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog', { name: 'New rule' });
    await user.type(within(dialog).getByLabelText('Pattern'), 'REWE');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Pick at least one tag.')).toBeInTheDocument();
    expect(createCashRule).not.toHaveBeenCalled();
  });

  test('explains the tag prerequisite on hover and focus, then enables creation when a tag exists', async () => {
    vi.mocked(listCashTags).mockResolvedValue({ tags: [] });
    const client = renderPage();
    const user = userEvent.setup();

    const newRule = await screen.findByRole('button', { name: 'New rule' });
    expect(newRule).toBeDisabled();

    await user.hover(newRule);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Create a tag first — a rule needs at least one to apply.',
    );

    await user.unhover(newRule);
    const hint = screen.getByRole('group');
    hint.focus();
    expect(hint).toHaveFocus();
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveTextContent('Create a tag first — a rule needs at least one to apply.');
      expect(hint).toHaveAttribute('aria-describedby', tooltip.id);
    });

    client.setQueryData(CASH_TAGS_QUERY_KEY, { tags: [FOOD] });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New rule' })).toBeEnabled();
    });
  });

  test('surfaces the unsupported-regex 400 inline', async () => {
    vi.mocked(createCashRule).mockRejectedValue(
      new ApiError(400, 'CASH_RULE_REGEX_UNSUPPORTED', 'unsupported'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog', { name: 'New rule' });
    await user.selectOptions(within(dialog).getByLabelText('Match type'), 'regex');
    await user.type(within(dialog).getByLabelText('Pattern'), '(?=x)');
    await user.click(within(dialog).getByText('Food'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'This regex uses unsupported syntax. Try a simpler pattern without lookarounds or backreferences.',
      ),
    ).toBeInTheDocument();
  });

  test('shows the disabled badge for an off rule', async () => {
    vi.mocked(listCashRules).mockResolvedValue({ rules: [rule({ enabled: false })] });
    renderPage();

    expect(await screen.findByText('Off')).toBeInTheDocument();
  });

  test('deletes a rule after confirmation', async () => {
    vi.mocked(listCashRules).mockResolvedValue({ rules: [rule()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(deleteCashRule).toHaveBeenCalledWith('r1');
  });

  test('renders the empty state with no rules', async () => {
    renderPage();

    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
  });

  test('does nothing when applying rules to existing movements is cancelled', async () => {
    vi.mocked(listCashRules).mockResolvedValue({ rules: [rule()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply to existing' }));

    expect(
      await screen.findByText(
        'Apply these rules to existing movements? This may re-apply tags to movements you manually retagged or untagged.',
      ),
    ).toBeInTheDocument();
    expect(applyCashRules).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(applyCashRules).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  test('applies rules to existing movements only after confirmation and reports how many were tagged', async () => {
    vi.mocked(listCashRules).mockResolvedValue({ rules: [rule()] });
    vi.mocked(applyCashRules).mockResolvedValue({ movementsTagged: 3 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply to existing' }));
    expect(applyCashRules).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(applyCashRules).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Tagged 3 movements.')).toBeInTheDocument();
  });

  test('says plainly when a run changed nothing, rather than claiming work', async () => {
    vi.mocked(listCashRules).mockResolvedValue({ rules: [rule()] });
    vi.mocked(applyCashRules).mockResolvedValue({ movementsTagged: 0 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Apply to existing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(/every matching movement already carries its tags/i),
    ).toBeInTheDocument();
  });

  test('offers no catch-up run when there are no rules to run', async () => {
    renderPage();

    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply to existing' })).not.toBeInTheDocument();
  });
});
