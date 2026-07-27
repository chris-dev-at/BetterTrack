export interface DerivedCacheKey {
  portfolioId: string;
  vaultVersion: number;
  assetPriceWatermark: string;
  range: string;
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
  return [key.portfolioId, key.vaultVersion, key.assetPriceWatermark, key.range].join('\u001f');
}
