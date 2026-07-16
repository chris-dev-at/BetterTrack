import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApplyImportResponse, ImportPreviewResponse, ImportRow } from '@bettertrack/contracts';

vi.mock('../../lib/importsApi');
vi.mock('../../lib/portfolioApi');
import * as importsApi from '../../lib/importsApi';
import * as portfolioApi from '../../lib/portfolioApi';
import { ApiError } from '../../lib/apiClient';

import { ImportPage } from './ImportPage';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PORTFOLIO_LIST = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private' as const,
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const BROKERS = { brokers: [{ id: 'trade_republic', label: 'Trade Republic' }] };

const CASH_SOURCES = {
  sources: [
    {
      id: 'src-main',
      name: 'Main',
      type: 'cash' as const,
      isMain: true,
      archivedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      balanceEur: 0,
    },
    {
      id: 'src-broker',
      name: 'Broker',
      type: 'bank' as const,
      isMain: false,
      archivedAt: null,
      createdAt: '2024-02-01T00:00:00.000Z',
      balanceEur: 100,
    },
  ],
};

function row(over: Partial<ImportRow> & Pick<ImportRow, 'id' | 'rowIndex' | 'flag'>): ImportRow {
  return {
    raw: 'raw',
    kind: 'buy',
    message: null,
    executedAt: '2024-01-15T12:00:00.000Z',
    isin: 'DE0001234567',
    symbol: null,
    name: 'Muster Tech AG',
    quantity: 10,
    price: 50,
    fee: 1,
    amountEur: null,
    currency: 'EUR',
    note: null,
    asset: { id: 'a1', symbol: 'MTA.DE', name: 'Muster Tech AG', currency: 'EUR' },
    result: null,
    resultMessage: null,
    ...over,
  };
}

const PREVIEW: ImportPreviewResponse = {
  batch: {
    id: 'batch-1',
    portfolioId: 'p1',
    brokerId: 'trade_republic',
    brokerLabel: 'Trade Republic',
    filename: 'export.csv',
    status: 'pending',
    createdAt: '2024-06-01T00:00:00.000Z',
    appliedAt: null,
    counts: { total: 4, mapped: 2, unmapped: 1, duplicate: 0, error: 1 },
  },
  rows: [
    row({ id: 'r1', rowIndex: 2, flag: 'mapped' }),
    row({
      id: 'r2',
      rowIndex: 3,
      flag: 'mapped',
      kind: 'dividend',
      quantity: null,
      price: null,
      amountEur: 12.5,
    }),
    row({
      id: 'r3',
      rowIndex: 4,
      flag: 'unmapped',
      asset: null,
      name: 'Unbekannte AG',
      message: 'Instrument "Unbekannte AG" was not found in the asset catalog.',
    }),
    row({
      id: 'r4',
      rowIndex: 5,
      flag: 'error',
      kind: null,
      executedAt: null,
      asset: null,
      name: null,
      isin: null,
      quantity: null,
      price: null,
      message: 'Unparseable date "kaputt".',
    }),
  ],
};

const APPLY_RESULT: ApplyImportResponse = {
  batch: { ...PREVIEW.batch, status: 'applied', appliedAt: '2024-06-01T00:01:00.000Z' },
  applied: 2,
  skipped: 2,
  failed: 0,
  rows: [
    { id: 'r1', rowIndex: 2, kind: 'buy', result: 'applied', message: null },
    { id: 'r2', rowIndex: 3, kind: 'dividend', result: 'applied', message: null },
    {
      id: 'r3',
      rowIndex: 4,
      kind: 'buy',
      result: 'skipped_unmapped',
      message: 'Instrument "Unbekannte AG" was not found in the asset catalog.',
    },
    { id: 'r4', rowIndex: 5, kind: null, result: 'skipped_error', message: 'Unparseable date.' },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/portfolio/import']}>
        <ImportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function uploadFixtureFile() {
  const user = userEvent.setup();
  const file = new File(['Datum;Typ'], 'export.csv', { type: 'text/csv' });
  await user.upload(screen.getByLabelText('CSV export'), file);
  await user.click(screen.getByRole('button', { name: 'Create preview' }));
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(portfolioApi.listCashSources).mockResolvedValue(CASH_SOURCES);
  vi.mocked(importsApi.listImportBrokers).mockResolvedValue(BROKERS);
  vi.mocked(importsApi.uploadImportBatch).mockResolvedValue(PREVIEW);
  vi.mocked(importsApi.applyImportBatch).mockResolvedValue(APPLY_RESULT);
  vi.mocked(importsApi.discardImportBatch).mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ImportPage', () => {
  test('uploads the chosen file and renders the preview with per-row flags', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    await uploadFixtureFile();

    await screen.findByText('Preview: export.csv');
    expect(vi.mocked(importsApi.uploadImportBatch)).toHaveBeenCalledWith({
      file: expect.any(File),
      portfolioId: 'p1',
    });

    // Counts strip + the four flag badges.
    expect(screen.getByText('4 rows')).toBeInTheDocument();
    expect(screen.getByText('2 mapped')).toBeInTheDocument();
    expect(screen.getAllByText('Mapped')).toHaveLength(2);
    expect(screen.getByText('Unmapped')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Unparseable date "kaputt".')).toBeInTheDocument();
    expect(screen.getAllByText('MTA.DE')).toHaveLength(2);
  });

  test('passes a manual broker pick through to the upload', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Broker'), 'trade_republic');
    await uploadFixtureFile();
    await screen.findByText('Preview: export.csv');
    expect(vi.mocked(importsApi.uploadImportBatch)).toHaveBeenCalledWith({
      file: expect.any(File),
      portfolioId: 'p1',
      brokerId: 'trade_republic',
    });
  });

  test('applies with the chosen cash source and shows the per-row result report', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    const user = await uploadFixtureFile();
    await screen.findByText('Preview: export.csv');

    await user.selectOptions(
      await screen.findByLabelText('Cash source (dividends & cash rows)'),
      'src-broker',
    );
    await user.click(screen.getByRole('button', { name: 'Import 2 rows' }));

    await screen.findByText('2 imported · 2 skipped · 0 failed');
    expect(vi.mocked(importsApi.applyImportBatch)).toHaveBeenCalledWith('batch-1', {
      cashSourceId: 'src-broker',
      linkCashOnTrades: false,
    });
    expect(screen.getAllByText('Imported')).toHaveLength(2);
    expect(screen.getByText('Skipped (unmapped)')).toBeInTheDocument();
    expect(screen.getByText('Skipped (error)')).toBeInTheDocument();
    // The apply controls are gone once the batch is applied.
    expect(screen.queryByRole('button', { name: 'Import 2 rows' })).not.toBeInTheDocument();
  });

  test('discard drops the staged batch and resets the page', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    const user = await uploadFixtureFile();
    await screen.findByText('Preview: export.csv');

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(vi.mocked(importsApi.discardImportBatch)).toHaveBeenCalledWith('batch-1'),
    );
    await waitFor(() => expect(screen.queryByText('Preview: export.csv')).not.toBeInTheDocument());
  });

  test('surfaces an upload rejection (e.g. unrecognized broker) as an alert', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockRejectedValue(
      new ApiError(
        400,
        'IMPORT_BROKER_UNRECOGNIZED',
        'This file does not match any supported broker export — pick the broker manually.',
      ),
    );
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    await uploadFixtureFile();
    await screen.findByText(
      'This file does not match any supported broker export — pick the broker manually.',
    );
    expect(screen.queryByText('Preview: export.csv')).not.toBeInTheDocument();
  });

  test('renders a designed empty state when the preview has no importable rows', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue({
      batch: {
        ...PREVIEW.batch,
        counts: { total: 0, mapped: 0, unmapped: 0, duplicate: 0, error: 0 },
      },
      rows: [],
    });
    renderPage();
    await screen.findByRole('option', { name: 'Trade Republic' });
    await uploadFixtureFile();
    await screen.findByText('Preview: export.csv');
    expect(await screen.findByText('No rows to import')).toBeInTheDocument();
    // The row table itself is not rendered when there is nothing to preview.
    expect(screen.queryByRole('columnheader', { name: 'Row' })).not.toBeInTheDocument();
  });
});
