import { expect, type Page } from '@playwright/test';

import { ACCOUNT_PASSWORD, API_BASE_URL } from './config';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

function viennaToday(now: Date): { epochMs: number; year: number } {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Vienna',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)!.value);
  const year = part('year');
  return { epochMs: Date.UTC(year, part('month') - 1, part('day')), year };
}

/** Exercise the cookie-session-only amendment ritual before booking an elapsed year. */
export async function unlockTaxYear(page: Page, year: number): Promise<void> {
  const response = await page.request.post(
    `${API_BASE_URL}/api/v1/settings/taxes/years/${year}/unlock`,
    {
      headers: CSRF_HEADERS,
      data: { password: ACCOUNT_PASSWORD },
    },
  );
  expect(response.ok(), `unlock tax year ${year} → ${await response.text()}`).toBeTruthy();
}

/** Close an explicitly opened elapsed tax year again through the owner's session. */
export async function relockTaxYear(page: Page, year: number): Promise<void> {
  const response = await page.request.post(
    `${API_BASE_URL}/api/v1/settings/taxes/years/${year}/relock`,
    { headers: CSRF_HEADERS },
  );
  expect(response.ok(), `relock tax year ${year} → ${await response.text()}`).toBeTruthy();
}

/**
 * Return `count` ascending ISO booking days ending yesterday in Europe/Vienna.
 * Invariant: every produced date is ≤ today in Vienna and lies in a tax year
 * that is open already (the current year) or is explicitly unlocked here before
 * return. Counting backward and unlocking every elapsed year keeps that true
 * when the window crosses New Year, including on 1–5 January.
 */
export async function recentOpenBookingDates(
  page: Page,
  count: number,
  now = new Date(),
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Booking-date count must be a positive integer.');
  }

  const today = viennaToday(now);
  const dates = Array.from({ length: count }, (_, index) =>
    new Date(today.epochMs - (count - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const elapsedYears = [
    ...new Set(dates.map((date) => Number(date.slice(0, 4))).filter((year) => year < today.year)),
  ];
  for (const year of elapsedYears) await unlockTaxYear(page, year);
  return dates;
}
