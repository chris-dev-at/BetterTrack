export interface DerivedCacheKey {
  ownerUserId: string;
  vaultKeyId: string;
  portfolioId: string;
  vaultVersion: number;
  writeId: string;
  assetPriceWatermark: string;
  range: string;
  /** UTC valuation day; portfolio callers set it so live results cannot cross midnight. */
  effectiveDay?: string;
}

/** In-memory only: decrypted derived rows are never persisted or sent remotely. */
export class VaultDerivedCache<T> {
  private readonly values = new Map<string, T>();

  get(key: DerivedCacheKey): T | undefined {
    return this.values.get(cacheKey(key));
  }

  set(key: DerivedCacheKey, value: T): void {
    this.values.set(cacheKey(key), value);
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}

function cacheKey(key: DerivedCacheKey): string {
  return [
    key.ownerUserId,
    key.vaultKeyId,
    key.portfolioId,
    key.vaultVersion,
    key.writeId,
    key.assetPriceWatermark,
    key.range,
    key.effectiveDay ?? '',
  ].join('\u001f');
}
