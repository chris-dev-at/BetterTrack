import { expect, test } from '@playwright/test';

import { recentBookingDates } from './dates';

test('recentBookingDates crosses Vienna New Year without setup', () => {
  for (const day of [1, 2, 3, 4, 5]) {
    const today = `2026-01-${String(day).padStart(2, '0')}`;
    const dates = recentBookingDates(5, new Date(`${today}T12:00:00.000Z`));

    expect(dates).toHaveLength(5);
    expect(dates.every((date) => date < today)).toBe(true);
  }
});
