const DEFAULT_SUFFIX = 'NEW';

export function formatDefaultDraftName(now: Date, entropy: string): string {
  const day = now.toISOString().slice(0, 10);
  const suffix = entropy.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || DEFAULT_SUFFIX;
  return `Draft ${day} ${suffix}`;
}

export function createDefaultDraftName(): string {
  const entropy =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return formatDefaultDraftName(new Date(), entropy);
}
