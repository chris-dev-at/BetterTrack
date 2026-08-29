import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ImportPreviewResponse, ImportRow, ImportUnderstanding } from '@bettertrack/contracts';

import { I18nProvider } from '../../../i18n';

vi.mock('../../../lib/importsApi');
vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/searchApi');
// Partial mock ON PURPOSE. Vitest's automock empties exported arrays, which
// would turn BOTH `CASH_TAGS_QUERY_KEY` and `IMPORT_BROKERS_QUERY_KEY` into
// `[]` — the two react-query caches would then collide on one key and the tag
// read would silently serve the broker list. Only the function is replaced.
vi.mock('../../../lib/cashApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/cashApi')>()),
  listCashTags: vi.fn(),
}));
import * as importsApi from '../../../lib/importsApi';
import * as portfolioApi from '../../../lib/portfolioApi';
import * as cashApi from '../../../lib/cashApi';
import * as searchApi from '../../../lib/searchApi';
import { ApiError } from '../../../lib/apiClient';

import { ImportPage } from '../ImportPage';

/**
 * The wizard's four non-negotiables, at the surface a person actually touches
 * (#964, §16 2026-07-31). `ImportPage.test.tsx` still owns the upload → confirm
 * → result spine; this file owns what the wizard ADDED, and every test here is
 * about a promise that would be invisible in a screenshot:
 *
 *  1. An AI column proposal is shown as a suggestion that was NOT used, and no
 *     control exists to apply one.
 *  2. A fuzzy candidate is never auto-applied — the user picks, and the pick
 *     goes to the server, which returns the new truth.
 *  3. Rows that could not be read are LISTED with their reason, never dropped.
 *  4. The staged facts the server persisted — rule tags, human provenance — are
 *     rendered from the payload rather than recomputed.
 */

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

const CASH_SOURCES = {
  sources: [
    {
      id: 'src-main',
      name: 'Main',
      type: 'cash' as const,
      isMain: true,
      archivedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      balanceEur: 500,
    },
  ],
};

const BROKERS = {
  brokers: [
    { id: 'trade_republic', label: 'Trade Republic' },
    { id: 'generic', label: 'Work it out from the file' },
  ],
};

function row(over: Partial<ImportRow> & Pick<ImportRow, 'id' | 'rowIndex' | 'flag'>): ImportRow {
  return {
    raw: 'raw;line',
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

/** A generic batch: it understood columns, and two rows still need a person. */
const UNDERSTANDING: ImportUnderstanding = {
  mappings: [
    {
      header: 'Buchungsdatum',
      field: 'date',
      confidence: 0.99,
      reason: "alias de 'Buchungsdatum'",
      needsReview: false,
    },
    {
      header: 'Betrag',
      field: 'amount',
      confidence: 0.97,
      reason: "alias de 'Betrag'",
      needsReview: false,
    },
    {
      header: 'Kurswert',
      field: 'amount',
      confidence: 0.6,
      reason: 'ai proposal (heavy tier) — a suggestion, not a mapping',
      needsReview: true,
      source: 'ai',
      alternativeOf: { header: 'Betrag', confidence: 0.97 },
    },
  ],
  unmappedHeaders: ['Handelsplatz'],
  delimiter: ';',
  encoding: 'utf-8',
  dateLocale: 'de',
  numberLocale: 'de',
  dateLocaleAmbiguous: false,
};

const UNRESOLVED = row({
  id: 'r-unmapped',
  rowIndex: 4,
  flag: 'unmapped',
  asset: null,
  name: 'Unbekannte AG',
  message: 'Instrument "Unbekannte AG" was not found in the asset catalog.',
  candidates: [
    {
      id: 'cand-1',
      symbol: 'UNB.DE',
      name: 'Unbekannte AG Inhaber',
      currency: 'EUR',
      exchange: 'XETRA',
      type: 'stock',
    },
  ],
});

const PREVIEW: ImportPreviewResponse = {
  batch: {
    id: 'batch-1',
    portfolioId: 'p1',
    brokerId: 'generic',
    brokerLabel: 'Work it out from the file',
    filename: 'statement.csv',
    status: 'pending',
    createdAt: '2024-06-01T00:00:00.000Z',
    appliedAt: null,
    counts: { total: 4, mapped: 2, unmapped: 1, duplicate: 0, error: 1 },
  },
  rows: [
    row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' }),
    row({
      id: 'r-cash',
      rowIndex: 3,
      flag: 'mapped',
      kind: 'deposit',
      quantity: null,
      price: null,
      amountEur: 2100,
      note: 'GEHALT ARBEITGEBER AG',
      asset: null,
      isin: null,
      name: null,
      ruleTagIds: ['tag-salary'],
    }),
    UNRESOLVED,
    row({
      id: 'r-error',
      rowIndex: 5,
      flag: 'error',
      kind: null,
      executedAt: null,
      asset: null,
      name: null,
      isin: null,
      quantity: null,
      price: null,
      message: 'The file\'s date order is ambiguous — "01/02/2024" could be day/month.',
    }),
  ],
  understanding: UNDERSTANDING,
};

function renderPage(locale?: 'en' | 'de') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/portfolio/import']}>
        <ImportPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(locale ? <I18nProvider initialLocale={locale}>{page}</I18nProvider> : page);
}

/** Upload the fixture and return the driver, leaving the wizard on step 2. */
async function upload(labels = { file: 'CSV export', cta: 'Create preview' }) {
  const user = userEvent.setup();
  await screen.findByRole('option', { name: 'Trade Republic' });
  await user.upload(
    screen.getByLabelText(labels.file),
    new File(['Buchungsdatum;Betrag'], 'statement.csv', { type: 'text/csv' }),
  );
  await user.click(screen.getByRole('button', { name: labels.cta }));
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(portfolioApi.listCashSources).mockResolvedValue(CASH_SOURCES);
  vi.mocked(importsApi.listImportBrokers).mockResolvedValue(BROKERS);
  vi.mocked(importsApi.uploadImportBatch).mockResolvedValue(PREVIEW);
  vi.mocked(cashApi.listCashTags).mockResolvedValue({
    tags: [
      {
        id: 'tag-salary',
        name: 'Salary',
        color: '#3355ff',
        system: false,
        systemKey: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  });
  vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [] });
});

describe('an AI column proposal is a suggestion, not a decision', () => {
  test('shows it apart from the mappings in force, and says it was not applied', async () => {
    renderPage();
    await upload();

    await screen.findByText('What we read from statement.csv');

    // The proposal is NOT in the table of columns the import reads from…
    const table = screen.getByRole('table');
    expect(within(table).queryByText('Kurswert')).not.toBeInTheDocument();
    expect(within(table).getByText('Buchungsdatum')).toBeInTheDocument();

    // …it is in its own block, labelled as unused, naming what it would have
    // displaced so the user can judge the guess rather than trust it.
    expect(screen.getByText('Suggestions we did not use')).toBeInTheDocument();
    expect(screen.getByText('Kurswert')).toBeInTheDocument();
    expect(screen.getByText('Suggestion — not applied')).toBeInTheDocument();
    expect(screen.getByText('would take over from Betrag')).toBeInTheDocument();
  });

  test('offers NO control that would apply one', async () => {
    renderPage();
    await upload();
    await screen.findByText('Suggestions we did not use');

    // The whole step has exactly two controls — Back and Continue. Any accept
    // affordance here would be a lie: the server has no endpoint to confirm a
    // proposal, so a button could only appear to work.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Back', 'Continue']);
  });

  test('a broker-mapper batch shows no understanding step at all', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue({
      ...PREVIEW,
      batch: { ...PREVIEW.batch, brokerId: 'trade_republic', brokerLabel: 'Trade Republic' },
      understanding: undefined,
    });
    renderPage();
    await upload();

    // It skips straight to the rows needing a person — no empty formality.
    await screen.findByText('What still needs you');
    expect(screen.queryByText('Suggestions we did not use')).not.toBeInTheDocument();
  });
});

describe('a fuzzy candidate is never auto-applied — the user picks', () => {
  test('lists the candidate with its provenance and pins it through the API', async () => {
    const resolved: ImportPreviewResponse = {
      ...PREVIEW,
      batch: { ...PREVIEW.batch, counts: { ...PREVIEW.batch.counts, mapped: 3, unmapped: 0 } },
      rows: PREVIEW.rows.map((r) =>
        r.id === 'r-unmapped'
          ? {
              ...r,
              flag: 'mapped' as const,
              message: null,
              asset: { id: 'cand-1', symbol: 'UNB.DE', name: 'Unbekannte AG', currency: 'EUR' },
              resolvedBy: 'user' as const,
            }
          : r,
      ),
    };
    vi.mocked(importsApi.resolveImportRow).mockResolvedValue(resolved);

    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('What still needs you');

    // Nothing was chosen for the user: the row is still unmatched, and the
    // candidate is shown with enough provenance to judge it.
    expect(screen.getByText('Unbekannte AG Inhaber')).toBeInTheDocument();
    expect(screen.getByText('XETRA · EUR · stock')).toBeInTheDocument();
    expect(vi.mocked(importsApi.resolveImportRow)).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Use this' }));

    await waitFor(() =>
      expect(vi.mocked(importsApi.resolveImportRow)).toHaveBeenCalledWith('batch-1', 'r-unmapped', {
        assetId: 'cand-1',
      }),
    );
    // The server's answer replaces the local view wholesale — the row leaves
    // the review list because the SERVER says it is mapped now.
    await waitFor(() =>
      expect(screen.queryByText('Unbekannte AG Inhaber')).not.toBeInTheDocument(),
    );
  });

  test('searching the catalog offers anything the user may legitimately book', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({
      results: [
        {
          id: 'own-1',
          providerId: 'manual',
          providerRef: 'own-1',
          symbol: 'MYCO',
          name: 'My Own Holding',
          exchange: null,
          type: 'stock',
          currency: 'EUR',
          isCustom: true,
        },
      ],
    });
    vi.mocked(importsApi.resolveImportRow).mockResolvedValue(PREVIEW);

    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('What still needs you');

    await user.type(screen.getByLabelText('Search the catalog'), 'My Own');
    // A custom asset the user created themselves is a legitimate pick — the
    // candidates list is a suggestion, not the boundary of what may be chosen.
    await screen.findByText('My Own Holding');
    await user.click(screen.getAllByRole('button', { name: 'Use this' })[1]!);

    await waitFor(() =>
      expect(vi.mocked(importsApi.resolveImportRow)).toHaveBeenCalledWith('batch-1', 'r-unmapped', {
        assetId: 'own-1',
      }),
    );
  });
});

describe('nothing is dropped silently', () => {
  test('lists the unreadable row with the reason it could not be imported', async () => {
    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    await screen.findByText("1 row we can't import without you");
    expect(screen.getByText(/The file's date order is ambiguous/)).toBeInTheDocument();
  });

  test('skips the review step entirely when every row was read and matched', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue({
      ...PREVIEW,
      rows: [row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' })],
      batch: {
        ...PREVIEW.batch,
        counts: { total: 1, mapped: 1, unmapped: 0, duplicate: 0, error: 0 },
      },
    });
    renderPage();
    const user = await upload();
    await screen.findByText('What we read from statement.csv');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Straight to confirm: a clean file is never asked a question.
    await screen.findByText('Preview: statement.csv');
    expect(screen.queryByText('What still needs you')).not.toBeInTheDocument();
  });
});

describe('the staged facts are rendered, not recomputed', () => {
  test('names the cash-rule tags the row was pre-tagged with, and badges a human pin', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue({
      ...PREVIEW,
      rows: [
        PREVIEW.rows[1]!,
        row({
          id: 'r-pinned',
          rowIndex: 6,
          flag: 'mapped',
          resolvedBy: 'user',
        }),
      ],
      understanding: undefined,
      batch: {
        ...PREVIEW.batch,
        counts: { total: 2, mapped: 2, unmapped: 0, duplicate: 0, error: 0 },
      },
    });
    renderPage();
    await upload();
    await screen.findByText('Preview: statement.csv');

    // The id on the wire becomes the name the user knows it by — awaited,
    // because the tag list is its own read that settles after the preview.
    expect(await screen.findByText('Salary')).toBeInTheDocument();
    // …and a row a person resolved is distinguishable from one the pipeline
    // matched exactly, so not every green row reads as equally verified.
    expect(screen.getByText('Pinned by you')).toBeInTheDocument();
  });

  test('a tag deleted between staging and now degrades to a label, not a crash', async () => {
    vi.mocked(cashApi.listCashTags).mockResolvedValue({ tags: [] });
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue({
      ...PREVIEW,
      rows: [PREVIEW.rows[1]!],
      understanding: undefined,
      batch: {
        ...PREVIEW.batch,
        counts: { total: 1, mapped: 1, unmapped: 0, duplicate: 0, error: 0 },
      },
    });
    renderPage();
    await upload();
    await screen.findByText('Preview: statement.csv');

    expect(screen.getByText('Deleted tag')).toBeInTheDocument();
  });
});

describe('German', () => {
  test('renders the wizard steps and the proposal warning in DE', async () => {
    renderPage('de');
    await upload({ file: 'CSV-Export', cta: 'Vorschau erstellen' });

    await screen.findByText('Das haben wir aus statement.csv gelesen');
    expect(screen.getByText('Vorschläge, die wir nicht verwendet haben')).toBeInTheDocument();
    expect(screen.getByText('Vorschlag — nicht angewendet')).toBeInTheDocument();
    // Server English must never reach the localized surface.
    expect(screen.queryByText('Suggestions we did not use')).not.toBeInTheDocument();
  });
});

describe('finishing the review step does not strand the wizard', () => {
  /**
   * Review B1. `steps` is recomputed from the preview, so pinning the LAST
   * unresolved row removes `review` from the list while the current step still
   * names it. Left unreconciled that renders "Step 0 of N" and turns Continue
   * into a jump back to the file picker — the user does exactly what the wizard
   * asked and gets thrown to the start.
   *
   * Both fixtures in the tests above keep an `error` row, which keeps `review`
   * alive whatever happens to the unmapped one — which is precisely why they
   * could not see this. This fixture has NO error row.
   */
  const CLEAN_UNRESOLVED: ImportPreviewResponse = {
    ...PREVIEW,
    rows: [row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' }), UNRESOLVED],
    batch: {
      ...PREVIEW.batch,
      counts: { total: 2, mapped: 1, unmapped: 1, duplicate: 0, error: 0 },
    },
  };

  test('advances to confirm when the last unresolved row is pinned', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue(CLEAN_UNRESOLVED);
    vi.mocked(importsApi.resolveImportRow).mockResolvedValue({
      ...CLEAN_UNRESOLVED,
      rows: [
        row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' }),
        row({ id: 'r-unmapped', rowIndex: 4, flag: 'mapped', resolvedBy: 'user' }),
      ],
      batch: {
        ...CLEAN_UNRESOLVED.batch,
        counts: { total: 2, mapped: 2, unmapped: 0, duplicate: 0, error: 0 },
      },
    });

    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('What still needs you');

    await user.click(screen.getByRole('button', { name: 'Use this' }));

    // The step it was on no longer exists, so the wizard moves FORWARD to the
    // next surviving one rather than falling off the list.
    await screen.findByText('Preview: statement.csv');
    expect(screen.queryByText('What still needs you')).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 0 of/)).not.toBeInTheDocument();
    // …and it is genuinely the last step: no Continue past confirm.
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });
});

describe('a pin in flight cannot be raced by the buttons around it', () => {
  /** A pin that never settles until the test lets it. */
  function pendingPin() {
    let release!: (value: ImportPreviewResponse) => void;
    const promise = new Promise<ImportPreviewResponse>((resolve) => {
      release = resolve;
    });
    vi.mocked(importsApi.resolveImportRow).mockReturnValue(promise);
    return { release };
  }

  const CLEAN_UNRESOLVED: ImportPreviewResponse = {
    ...PREVIEW,
    rows: [row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' }), UNRESOLVED],
    batch: {
      ...PREVIEW.batch,
      counts: { total: 2, mapped: 1, unmapped: 1, duplicate: 0, error: 0 },
    },
  };

  test('freezes navigation and the other candidates until the server answers (B2)', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue(CLEAN_UNRESOLVED);
    const { release } = pendingPin();

    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('What still needs you');
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    // The server's answer decides which rows are importable AND whether this
    // step still exists, so nothing may move until it lands: no stepping
    // forward onto a preview that is about to change, no stepping back, and no
    // second pick racing the first.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this' })).toBeDisabled();

    release({
      ...CLEAN_UNRESOLVED,
      rows: [
        row({ id: 'r-mapped', rowIndex: 2, flag: 'mapped' }),
        row({ id: 'r-unmapped', rowIndex: 4, flag: 'mapped', resolvedBy: 'user' }),
      ],
      batch: {
        ...CLEAN_UNRESOLVED.batch,
        counts: { total: 2, mapped: 2, unmapped: 0, duplicate: 0, error: 0 },
      },
    });

    // Once it lands the wizard moves on and the write becomes available.
    await screen.findByText('Preview: statement.csv');
    expect(screen.getByRole('button', { name: /^Import / })).toBeEnabled();
  });

  test('a pin error survives on screen instead of being cleared by the next success', async () => {
    vi.mocked(importsApi.uploadImportBatch).mockResolvedValue(CLEAN_UNRESOLVED);
    vi.mocked(importsApi.resolveImportRow).mockRejectedValue(
      new ApiError(409, 'IMPORT_ALREADY_APPLIED', 'This import was already applied.'),
    );

    renderPage();
    const user = await upload();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('What still needs you');
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    // The server's 409 — the apply/pin race PR-A closes — reaches the user.
    expect(await screen.findByText('This import was already applied.')).toBeInTheDocument();
  });
});
