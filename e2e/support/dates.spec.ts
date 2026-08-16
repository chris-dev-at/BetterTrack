import { expect, test, type Page } from '@playwright/test';

import { API_BASE_URL } from './config';
import { recentOpenBookingDates } from './dates';

test('recentOpenBookingDates keeps booking days open across Vienna New Year', async () => {
  for (const day of [1, 2, 3, 4, 5]) {
    const unlockedYears: number[] = [];
    const unlockUrls: string[] = [];
    const page = {
      request: {
        post: async (url: string) => {
          const year = /years\/(\d+)\/unlock$/.exec(url)?.[1];
          if (year) {
            unlockUrls.push(url);
            unlockedYears.push(Number(year));
          }
          return { ok: () => true, text: async () => '' };
        },
      },
    } as unknown as Page;
    const today = `2026-01-${String(day).padStart(2, '0')}`;
    const dates = await recentOpenBookingDates(page, 5, new Date(`${today}T12:00:00.000Z`));

    expect(dates).toHaveLength(5);
    expect(dates.every((date) => date < today)).toBe(true);
    expect(unlockUrls).toEqual([`${API_BASE_URL}/api/v1/settings/taxes/years/2025/unlock`]);
    expect(unlockedYears).toEqual([
      ...new Set(dates.map((date) => Number(date.slice(0, 4))).filter((year) => year < 2026)),
    ]);
  }
});
