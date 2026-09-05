import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NEWS_TTL_SECONDS } from '../../../providers/ttl';

/**
 * The server's news freshness window must stay strictly longer than every
 * client stale window that drives the news reads. When a client's `staleTime`
 * is as long as — or longer than — the
 * server TTL, every refetch lands on an expired cache entry, so the news digest
 * re-fans-out over the caller's whole book on essentially every load — the
 * §5.3 upstream-politeness keystone paying for a constant mismatch.
 *
 * This pin reads the real web sources rather than restating their numbers, so
 * raising a client window past the TTL fails here instead of silently drifting.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/** The web surfaces that drive `/assets/portfolio/news-digest`. */
const NEWS_DIGEST_CLIENTS = [
  'apps/web/src/user/home/widgets/NewsWidget.tsx',
  'apps/web/src/user/assets/NewsDigestPage.tsx',
] as const;

/** Evaluate the small numeric literal forms these constants use (`15 * 60_000`). */
function numericLiteral(expression: string): number | undefined {
  const cleaned = expression.replace(/_/g, '').trim();
  if (!/^[\d\s*]+$/.test(cleaned)) return undefined;
  const factors = cleaned.split('*').map((part) => Number(part.trim()));
  if (factors.some((factor) => !Number.isFinite(factor))) return undefined;
  return factors.reduce((product, factor) => product * factor, 1);
}

/**
 * Every `staleTime:` in the file, resolved to milliseconds — inline literals as
 * well as the `const NAME = <literal>` indirection the digest page uses.
 */
function staleWindowsMs(source: string): number[] {
  const windows: number[] = [];
  for (const match of source.matchAll(/staleTime:\s*([^,\n]+)/g)) {
    const expression = match[1]!.trim();
    const direct = numericLiteral(expression);
    if (direct !== undefined) {
      windows.push(direct);
      continue;
    }
    const named = new RegExp(`const\\s+${expression}\\s*=\\s*([^;\\n]+)`).exec(source);
    const resolved = named ? numericLiteral(named[1]!) : undefined;
    expect(
      resolved,
      `could not resolve staleTime "${expression}" — re-point this pin at the moved constant`,
    ).toBeDefined();
    if (resolved !== undefined) windows.push(resolved);
  }
  return windows;
}

describe('NEWS_TTL_SECONDS vs the client stale windows that drive it', () => {
  for (const file of NEWS_DIGEST_CLIENTS) {
    it(`covers every stale window in ${file}`, () => {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      // A driver with no stale window would mean this pin stopped watching it.
      const windows = staleWindowsMs(source);
      expect(windows.length, `${file} declares no staleTime`).toBeGreaterThan(0);
      for (const window of windows) {
        // STRICTLY longer, not ">=": the two clocks start together (the client's
        // fetch populates the cache entry), so an equal window expires exactly
        // when the entry does and every refetch is a guaranteed miss — the
        // outcome this pin exists to prevent, which ">=" waved through (#1758).
        expect(
          NEWS_TTL_SECONDS * 1000,
          `${file} refetches every ${window} ms; NEWS_TTL_SECONDS must be strictly longer`,
        ).toBeGreaterThan(window);
      }
    });
  }
});
