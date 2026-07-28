import type {
  CustomTaxParams,
  TaxCountry,
  TaxMode,
  VaultDocument,
  VaultDocumentV1,
  VaultEnvelopeHeader,
} from '@bettertrack/contracts';

import type { MarketDataSource, MarketDataValue } from '../../../lib/marketDataSource';
import { decryptVaultDocument } from '../crypto';
import type { DataHome } from '../dataHome';
import type { VaultSyncEngine, VaultSyncState } from '../sync';
import fixture from './clientMoney.fixture.json';

export const CLIENT_MONEY_IDS = {
  user: '018f0000-0000-7000-8000-000000000101',
  portfolio: '018f0000-0000-7000-8000-000000000102',
  cashSource: '018f0000-0000-7000-8000-000000000103',
  eurAsset: '018f0000-0000-7000-8000-000000000104',
  usdAsset: '018f0000-0000-7000-8000-000000000105',
  device: '018f0000-0000-7000-8000-000000000106',
  taxSetting: '018f0000-0000-7000-8000-000000000117',
} as const;

const MALFORMED_TAX_OVERRIDE_ID = '018f0000-0000-7000-8000-000000000197';
const VALID_CUSTOM_TAX_PARAMS = {
  ratePct: 20,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'fifo',
} satisfies CustomTaxParams;

interface TaxSettingInvariantCase {
  state: string;
  defaultData: Record<string, unknown>;
  overrideValue: Record<string, unknown>;
}

export interface MalformedTaxSettingCase {
  state: string;
  scope: 'user default' | 'portfolio override';
  data: Record<string, unknown>;
}

const TAX_SETTING_INVARIANT_CASES: readonly TaxSettingInvariantCase[] = [
  {
    state: 'country-specific mode without a country',
    defaultData: defaultTaxSetting({ mode: 'country_specific' }),
    overrideValue: portfolioTaxOverride({ mode: 'country_specific' }),
  },
  {
    state: 'a country outside country-specific mode',
    defaultData: defaultTaxSetting({ country: 'DE' }),
    overrideValue: portfolioTaxOverride({ country: 'DE' }),
  },
  {
    state: 'country-specific mode with custom parameters',
    defaultData: defaultTaxSetting({
      mode: 'country_specific',
      country: 'DE',
      customParams: VALID_CUSTOM_TAX_PARAMS,
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'country_specific',
      country: 'DE',
      custom: VALID_CUSTOM_TAX_PARAMS,
    }),
  },
  {
    state: 'custom mode without parameters',
    defaultData: defaultTaxSetting({ mode: 'custom' }),
    overrideValue: portfolioTaxOverride({ mode: 'custom' }),
  },
  {
    state: 'custom mode with a non-strict parameter set',
    defaultData: defaultTaxSetting({ mode: 'custom', customParams: { ratePct: 20 } }),
    overrideValue: portfolioTaxOverride({ mode: 'custom', custom: { ratePct: 20 } }),
  },
  {
    state: 'custom mode with a country',
    defaultData: defaultTaxSetting({
      mode: 'custom',
      country: 'DE',
      customParams: VALID_CUSTOM_TAX_PARAMS,
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'custom',
      country: 'DE',
      custom: VALID_CUSTOM_TAX_PARAMS,
    }),
  },
  {
    state: 'a manual amount outside manual mode',
    defaultData: defaultTaxSetting({ manualDefaultAmountEur: '1' }),
    overrideValue: portfolioTaxOverride({ manualDefaultAmountEur: 1 }),
  },
  {
    state: 'both manual amount and rate defaults',
    defaultData: defaultTaxSetting({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: '1',
      manualDefaultRatePct: '20',
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: 1,
      manualDefaultRatePct: 20,
    }),
  },
  {
    state: 'a negative manual amount',
    defaultData: defaultTaxSetting({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: '-0.000001',
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: -0.000001,
    }),
  },
  {
    state: 'a negative manual rate',
    defaultData: defaultTaxSetting({
      mode: 'manual_per_trade',
      manualDefaultRatePct: '-0.000001',
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'manual_per_trade',
      manualDefaultRatePct: -0.000001,
    }),
  },
  {
    state: 'a manual rate above 100',
    defaultData: defaultTaxSetting({
      mode: 'manual_per_trade',
      manualDefaultRatePct: '100.000001',
    }),
    overrideValue: portfolioTaxOverride({
      mode: 'manual_per_trade',
      manualDefaultRatePct: 100.000001,
    }),
  },
];

export const MALFORMED_TAX_SETTING_CASES: readonly MalformedTaxSettingCase[] =
  TAX_SETTING_INVARIANT_CASES.flatMap((testCase) => [
    {
      state: testCase.state,
      scope: 'user default',
      data: testCase.defaultData,
    },
    {
      state: testCase.state,
      scope: 'portfolio override',
      data: testCase.overrideValue,
    },
  ]);

export async function decryptClientMoneyFixture(): Promise<{
  document: VaultDocumentV1;
  header: VaultEnvelopeHeader;
  envelope: Uint8Array;
  vaultKey: Uint8Array;
}> {
  const envelope = Uint8Array.from(Buffer.from(fixture.envelopeBase64, 'base64'));
  const vaultKey = Uint8Array.from(Buffer.from(fixture.vaultKeyBase64, 'base64'));
  const { document, header } = await decryptVaultDocument(envelope, vaultKey);
  if (document.schemaVersion !== 1) {
    throw new Error('The client-money fixture must decrypt to a v1 vault document.');
  }
  return { document, header, envelope, vaultKey };
}

export interface MutableTestSync extends VaultSyncEngine {
  readonly mutationCount: number;
  setDocument(document: VaultDocument, bumpVersion?: boolean, writeId?: string): void;
  setStatus(status: 'synced' | 'conflict' | 'unresolved'): void;
  setLocked(): void;
}

export function createMutableTestSync(
  document: VaultDocument,
  header: VaultEnvelopeHeader,
  envelope = new Uint8Array(),
): MutableTestSync {
  let version = header.vaultVersion;
  let activeWriteId = header.writeId;
  let candidateSequence = 0;
  let mutations = 0;
  let state = syncedState(document);
  let tail: Promise<void> = Promise.resolve();

  function syncedState(nextDocument: VaultDocument): VaultSyncState {
    return {
      status: 'synced',
      active: {
        home: MEMORY_HOME,
        envelope,
        header: { ...header, vaultVersion: version, writeId: activeWriteId },
        document: nextDocument,
      },
      pending: null,
    };
  }

  return {
    deviceId: CLIENT_MONEY_IDS.device,
    get state() {
      return state;
    },
    get mutationCount() {
      return mutations;
    },
    async start() {
      return state;
    },
    async reconnect() {
      return state;
    },
    async mutate(mutator) {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        const active = state.active;
        if (state.status === 'locked' || active === null) {
          throw new DOMException('Vault locked.', 'AbortError');
        }
        const next = mutator({ document: active.document, currentVersion: version });
        mutations += 1;
        version += 1;
        candidateSequence += 1;
        activeWriteId = testWriteId(candidateSequence);
        state = syncedState(next);
        return state;
      } finally {
        release();
      }
    },
    setDocument(nextDocument, bumpVersion = true, writeId) {
      if (bumpVersion) {
        version += 1;
        candidateSequence += 1;
        activeWriteId = testWriteId(candidateSequence);
      }
      if (writeId !== undefined) activeWriteId = writeId;
      state = syncedState(nextDocument);
    },
    setStatus(status) {
      state = { ...state, status };
    },
    setLocked() {
      state = { status: 'locked', active: null, pending: null };
    },
  };
}

function testWriteId(sequence: number): string {
  return `018f0000-0000-7000-8000-${(0x200 + sequence).toString(16).padStart(12, '0')}`;
}

export interface TestMarketControls {
  market: MarketDataSource;
  calls: {
    quote: string[];
    history: string[];
    fx: string[];
  };
  setQuoteWatermark(value: string): void;
  setFxWatermark(value: string): void;
  setMissingQuote(assetId: string, missing: boolean): void;
  setStale(stale: boolean): void;
}

export function createClientMoneyMarket(): TestMarketControls {
  const calls = { quote: [] as string[], history: [] as string[], fx: [] as string[] };
  const missingQuotes = new Set<string>();
  let quoteWatermark = 'quotes-v1';
  let fxWatermark = 'fx-v1';
  let stale = false;
  const histories = new Map<string, Array<{ time: string; close: number }>>([
    [
      CLIENT_MONEY_IDS.eurAsset,
      [100, 105, 110, 115, 120, 125, 128].map((close, index) => ({
        time: `2026-07-${String(index + 20).padStart(2, '0')}T20:00:00.000Z`,
        close,
      })),
    ],
    [
      CLIENT_MONEY_IDS.usdAsset,
      [40, 41, 42, 43, 44, 45, 46].map((close, index) => ({
        time: `2026-07-${String(index + 20).padStart(2, '0')}T20:00:00.000Z`,
        close,
      })),
    ],
  ]);

  const market: MarketDataSource = {
    async quote(assetId) {
      calls.quote.push(assetId);
      if (missingQuotes.has(assetId)) throw new Error('missing quote');
      const usd = assetId === CLIENT_MONEY_IDS.usdAsset;
      return {
        value: {
          price: usd ? 50 : 130,
          currency: usd ? 'USD' : 'EUR',
          prevClose: usd ? 46 : 128,
          asOf: '2026-07-27T12:00:00.000Z',
        },
        stale,
        asOf: '2026-07-27T12:00:00.000Z',
        watermark: `${quoteWatermark}:${assetId}`,
      };
    },
    async history(assetId) {
      calls.history.push(assetId);
      const value = histories.get(assetId);
      if (value === undefined) throw new Error('missing history');
      return {
        value,
        stale,
        asOf: '2026-07-27T08:00:00.000Z',
        watermark: `history-v1:${assetId}`,
      };
    },
    async search() {
      return { value: [], stale: false, asOf: null, watermark: 'empty' };
    },
    async fx(from, to, date) {
      calls.fx.push(`${from}:${to}:${date ?? 'spot'}`);
      const value = from === to || from === 'EUR' ? 1 : from === 'USD' && to === 'EUR' ? 0.9 : NaN;
      if (!Number.isFinite(value)) throw new Error('unsupported FX');
      return {
        value,
        from,
        to,
        date: date ?? null,
        stale,
        asOf: date === undefined ? '2026-07-27T12:00:00.000Z' : `${date}T20:00:00.000Z`,
        watermark: `${fxWatermark}:${from}:${to}:${date ?? 'spot'}:${value}`,
      };
    },
  };
  return {
    market,
    calls,
    setQuoteWatermark(value) {
      quoteWatermark = value;
    },
    setFxWatermark(value) {
      fxWatermark = value;
    },
    setMissingQuote(assetId, missing) {
      if (missing) missingQuotes.add(assetId);
      else missingQuotes.delete(assetId);
    },
    setStale(value) {
      stale = value;
    },
  };
}

export function withTaxSettings(
  document: VaultDocumentV1,
  mode: TaxMode,
  country: TaxCountry | null,
  customParams: CustomTaxParams | null,
): VaultDocumentV1 {
  const next = structuredClone(document);
  const setting = next.entities.taxSetting?.find(
    (entity) => entity.id === CLIENT_MONEY_IDS.taxSetting,
  );
  if (setting === undefined) throw new Error('Fixture tax setting is missing.');
  setting.rev += 1;
  setting.editedAt = '2026-07-27T09:00:00.000Z';
  setting.data = {
    ...setting.data,
    mode,
    country,
    customParams,
    updatedAt: setting.editedAt,
  };
  return next;
}

export function withMalformedTaxSetting(
  document: VaultDocumentV1,
  testCase: MalformedTaxSettingCase,
): VaultDocumentV1 {
  const next = structuredClone(document);
  const source = next.entities.taxSetting?.find(
    (entity) => entity.id === CLIENT_MONEY_IDS.taxSetting,
  );
  if (source === undefined) throw new Error('Fixture tax setting is missing.');

  if (testCase.scope === 'user default') {
    source.data = {
      ...source.data,
      ...structuredClone(testCase.data),
      updatedAt: source.editedAt,
    };
    return next;
  }

  const otherSettings = (next.entities.portfolioSetting ?? []).filter(
    (entity) => entity.data.portfolioId !== CLIENT_MONEY_IDS.portfolio || entity.data.key !== 'tax',
  );
  next.entities.portfolioSetting = [
    ...otherSettings,
    {
      id: MALFORMED_TAX_OVERRIDE_ID,
      rev: 0,
      editedAt: source.editedAt,
      editedBy: source.editedBy,
      deletedAt: null,
      data: {
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        key: 'tax',
        value: structuredClone(testCase.data),
        updatedAt: source.editedAt,
      },
    },
  ];
  return next;
}

function defaultTaxSetting(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: 'none',
    country: null,
    manualDefaultAmountEur: null,
    manualDefaultRatePct: null,
    customParams: null,
    ...overrides,
  };
}

function portfolioTaxOverride(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: 'none',
    country: null,
    ...overrides,
  };
}

const MEMORY_HOME: DataHome = {
  medium: 'local',
  async read() {
    return { status: 'absent', medium: 'local' };
  },
  async write() {
    return { status: 'conflict', medium: 'local', currentVersion: null };
  },
  async info() {
    return { status: 'absent', medium: 'local' };
  },
};

/** A typed helper for custom market values in targeted race tests. */
export function marketValue<T>(value: T, watermark: string): MarketDataValue<T> {
  return { value, watermark, stale: false, asOf: '2026-07-27T12:00:00.000Z' };
}
