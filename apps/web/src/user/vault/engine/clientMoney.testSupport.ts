import type {
  CustomTaxParams,
  TaxCountry,
  TaxMode,
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

export async function decryptClientMoneyFixture(): Promise<{
  document: VaultDocumentV1;
  header: VaultEnvelopeHeader;
  envelope: Uint8Array;
  vaultKey: Uint8Array;
}> {
  const envelope = Uint8Array.from(Buffer.from(fixture.envelopeBase64, 'base64'));
  const vaultKey = Uint8Array.from(Buffer.from(fixture.vaultKeyBase64, 'base64'));
  const decrypted = await decryptVaultDocument(envelope, vaultKey);
  return { ...decrypted, envelope, vaultKey };
}

export interface MutableTestSync extends VaultSyncEngine {
  readonly mutationCount: number;
  setDocument(document: VaultDocumentV1, bumpVersion?: boolean, writeId?: string): void;
  setStatus(status: 'synced' | 'conflict' | 'unresolved'): void;
  setLocked(): void;
}

export function createMutableTestSync(
  document: VaultDocumentV1,
  header: VaultEnvelopeHeader,
  envelope = new Uint8Array(),
): MutableTestSync {
  let version = header.vaultVersion;
  let activeWriteId = header.writeId;
  let candidateSequence = 0;
  let mutations = 0;
  let state = syncedState(document);
  let tail: Promise<void> = Promise.resolve();

  function syncedState(nextDocument: VaultDocumentV1): VaultSyncState {
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
