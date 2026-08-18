import { expect, request as newRequestContext, test } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { API_BASE_URL } from './support/config';

test('admin harness reuses one assured session without authenticating ordinary contexts', async () => {
  const first = await newAdminRequestContext(newRequestContext);
  const second = await newAdminRequestContext(newRequestContext);
  const anonymous = await newRequestContext.newContext({ baseURL: API_BASE_URL });

  try {
    const firstState = await first.storageState();
    const secondState = await second.storageState();
    const anonymousState = await anonymous.storageState();
    const firstSession = firstState.cookies.find((cookie) => cookie.name === 'bt_sid');
    const secondSession = secondState.cookies.find((cookie) => cookie.name === 'bt_sid');

    expect(first).not.toBe(second);
    expect(firstSession?.value).toBeTruthy();
    expect(secondSession?.value).toBe(firstSession?.value);
    expect(anonymousState.cookies.some((cookie) => cookie.name === 'bt_sid')).toBe(false);

    const [firstStatus, secondStatus, anonymousStatus] = await Promise.all([
      first.get(`${API_BASE_URL}/api/v1/admin/security/2fa/status`),
      second.get(`${API_BASE_URL}/api/v1/admin/security/2fa/status`),
      anonymous.get(`${API_BASE_URL}/api/v1/admin/security/2fa/status`),
    ]);
    expect(firstStatus.status()).toBe(200);
    expect(secondStatus.status()).toBe(200);
    expect(anonymousStatus.status()).toBe(404);
  } finally {
    await Promise.all([first.dispose(), second.dispose(), anonymous.dispose()]);
  }
});
