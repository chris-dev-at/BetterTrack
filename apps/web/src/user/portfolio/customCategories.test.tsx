import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';

import { CUSTOM_ASSET_CATEGORIES } from '@bettertrack/contracts';

import { I18nProvider, useT } from '../../i18n';
import { customCategoryLabels } from './customCategories';

/**
 * Web-side guard for the V3-P2 acceptance criterion (issue #325): *"No CUSTOM
 * category/slice remains in any UI or API response."* {@link customCategoryLabels}
 * is the canonical custom-investment category label map shared by the create
 * dialog and the value-point editor. This sweep proves — across the whole catalog
 * enum, in both shipped locales — that it labels every real category and never
 * re-introduces the retired CUSTOM slice or a dead `real_estate/vehicle/collectible`
 * token. Complements the tree-wide `taxonomy/no-custom-category-slice` lint gate
 * and the per-surface donut tests in PortfolioPage / SharedPortfolioPage.
 */
const LEGACY_TOKENS = ['real_estate', 'vehicle', 'collectible', 'custom'];

function wrapper(locale: string) {
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider initialLocale={locale}>{children}</I18nProvider>
  );
}

describe('custom-category taxonomy sweep (V3-P2 #325)', () => {
  test('the catalog enum carries none of the legacy/CUSTOM tokens', () => {
    const categories = CUSTOM_ASSET_CATEGORIES as readonly string[];
    for (const token of LEGACY_TOKENS) {
      expect(categories).not.toContain(token);
    }
  });

  test.each(['en', 'de'])(
    'customCategoryLabels(%s) labels every category and yields no CUSTOM slice',
    (locale) => {
      const { result } = renderHook(() => customCategoryLabels(useT()), {
        wrapper: wrapper(locale),
      });
      const labels = result.current;

      // The label map keys are exactly the catalog enum — no `custom`, no dead token.
      expect(Object.keys(labels).sort()).toEqual([...CUSTOM_ASSET_CATEGORIES].sort());
      for (const token of LEGACY_TOKENS) {
        expect(Object.keys(labels)).not.toContain(token);
      }

      // Every category resolves to a real, non-empty label, and none reads as a
      // bare "Custom" slice.
      for (const category of CUSTOM_ASSET_CATEGORIES) {
        const label = labels[category];
        expect(label).toBeTruthy();
        expect(label.trim().toLowerCase()).not.toBe('custom');
      }
    },
  );
});
