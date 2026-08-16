import { expect, type Page } from '@playwright/test';

import { ACCOUNT_PASSWORD, API_BASE_URL } from './config';

const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

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
