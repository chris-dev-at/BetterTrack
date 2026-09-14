import { randomUUID } from 'node:crypto';

import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import {
  createCaptureReceiver,
  createWebhookHarness,
  independentSignature,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type CaptureReceiver,
} from './support/e3';
import { provisionUser } from './support/users';

/**
 * V5-P14 [E3] — outbound-webhook delivery ([#737], §13.5 V5-P10).
 *
 * The two owner-mandated browser gates for the webhooks platform:
 *
 *  1. a webhook created through Settings delivers an HMAC-signed payload to a
 *     local receiver, and the signature verifies INDEPENDENTLY over the captured
 *     body (never exposing the signing secret);
 *  2. a dead receiver drives bounded retries, auto-disables after the configured
 *     consecutive-failure threshold, and can be manually re-enabled from Settings.
 *
 * Production delivery is the BullMQ `webhooks.deliver` job (bridge → queue →
 * dispatcher, with exponential backoff), which a browser can't observe without
 * arbitrary sleeps. Per the E1/E2 precedent, `support/e3.ts` builds the REAL
 * dispatcher + production address-pinned transport against the same Playwright
 * database and drives `deliver()` with explicit attempt contexts, POSTing to an in-process
 * loopback receiver — so signatures, the retry boundary and the auto-disable
 * streak are exercised deterministically, network-free, with no product change.
 *
 * Lowercased once — Node lowercases inbound header names, and the receiver stores
 * them that way.
 */
const SIG_HEADER = WEBHOOK_SIGNATURE_HEADER.toLowerCase();
const TS_HEADER = WEBHOOK_TIMESTAMP_HEADER.toLowerCase();
const EVENT_HEADER = WEBHOOK_EVENT_HEADER.toLowerCase();
const DELIVERY_HEADER = WEBHOOK_DELIVERY_HEADER.toLowerCase();

/**
 * The signing secret is shown ONCE in a modal on create; a failure trace would
 * otherwise capture that plaintext. Turn tracing off for this file so no artifact
 * can ever carry the secret — the specs read the secret only by decrypting the
 * stored envelope in the harness, never from the modal.
 */
test.use({ trace: 'off' });

/**
 * Drive the real Control Center → Webhooks panel to create ONE webhook
 * subscribed to "Price alert triggered", pointed at the local receiver.
 * Dismisses the one-time secret modal WITHOUT reading its plaintext (the
 * harness decrypts the stored secret instead).
 */
async function createWebhookViaSettings(page: Page, receiver: CaptureReceiver): Promise<void> {
  await page.goto('/control/webhooks');
  // Webhooks is its own Control Center panel now, so the form is open on
  // arrival — the outer collapse only made sense while it was nested inside
  // the API-access page.
  await expect(page.getByLabel('Payload URL')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Payload URL').fill(`${receiver.url}/hook`);
  await page.getByLabel('Label (optional)').fill('E3 receiver');
  await page.getByLabel('Price alert triggered').check();
  await page.getByRole('button', { name: 'Add webhook' }).click();

  // The one-time secret modal — acknowledge and dismiss without scraping it.
  // Named: the Control Center popup is itself `role="dialog" aria-modal`, so a
  // bare dialog locator matches two elements.
  const dialog = page.getByRole('dialog', { name: 'Your webhook signing secret' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: "I've saved this" }).click();
  await expect(dialog).toBeHidden();
}

test('webhooks: a Settings-created webhook delivers a verifiable signed payload', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const receiver = await createCaptureReceiver();
  const harness = createWebhookHarness();
  const apiRequest = await newAdminRequestContext(newRequestContext);
  const owner = await provisionUser(browser, apiRequest, 'whdeliver');
  await apiRequest.dispose();

  try {
    await createWebhookViaSettings(owner.page, receiver);

    const sub = await harness.subscriptionForEmail(owner.email);
    const secret = harness.secretFor(sub);

    // One delivery through the real dispatcher (receiver accepts → 2xx).
    const deliveryId = randomUUID();
    const result = await harness.deliver(sub.id, { deliveryId, attempt: 1, maxAttempts: 5 });
    expect(result.outcome).toBe('delivered');

    // The receiver saw exactly one POST.
    expect(receiver.requests).toHaveLength(1);
    const captured = receiver.requests[0]!;

    // INDEPENDENT signature verification: recompute the HMAC over the captured
    // timestamp + body and match the header the delivery carried.
    const timestamp = captured.headers[TS_HEADER]!;
    expect(captured.headers[SIG_HEADER]).toBe(
      independentSignature(secret, timestamp, captured.body),
    );

    // The secret never rides the wire — not in the signature, not in the body.
    expect(captured.headers[SIG_HEADER]).not.toContain(secret);
    expect(captured.body).not.toContain(secret);

    // Envelope + routing headers are exactly what a receiver dedupes/routes on.
    expect(captured.headers[EVENT_HEADER]).toBe('alert.triggered');
    expect(captured.headers[DELIVERY_HEADER]).toBe(deliveryId);
    const payload = JSON.parse(captured.body) as { id: string; type: string };
    expect(payload.id).toBe(deliveryId);
    expect(payload.type).toBe('alert.triggered');

    // The delivery-log surfaces the success in the Control Center.
    const page = owner.page;
    await page.goto('/control/webhooks');
    const row = page.getByRole('listitem').filter({ hasText: receiver.url });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Deliveries' }).click();
    await expect(row.getByText('Delivered')).toBeVisible({ timeout: 15_000 });
  } finally {
    await harness.dispose();
    await receiver.close();
    await owner.context.close();
  }
});

test('webhooks: a dead receiver retries, auto-disables, and re-enables from Settings', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const receiver = await createCaptureReceiver();
  const harness = createWebhookHarness();
  const apiRequest = await newAdminRequestContext(newRequestContext);
  const owner = await provisionUser(browser, apiRequest, 'whdisable');
  await apiRequest.dispose();

  try {
    await createWebhookViaSettings(owner.page, receiver);
    const sub = await harness.subscriptionForEmail(owner.email);

    // Every delivery attempt now fails (receiver returns 500).
    receiver.setStatus(500);

    // Failure #1 as a FULL retry cycle sharing one delivery id: attempts 1‑4 are
    // retryable, attempt 5 is terminal. Bounded — exactly `maxAttempts` POSTs —
    // and the log/streak advance ONCE (retries never double-count).
    const cycleId = randomUUID();
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const r = await harness.deliver(sub.id, { deliveryId: cycleId, attempt, maxAttempts: 5 });
      outcomes.push(r.outcome);
    }
    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'retry', 'failed']);
    expect(receiver.requests).toHaveLength(5);
    expect((await harness.reload(sub.id)).consecutiveFailures).toBe(1);

    // Failures #2…#threshold as immediate-terminal deliveries; the LAST one
    // crosses the consecutive-failure threshold and auto-disables the webhook.
    let lastOutcome = '';
    for (let failure = 2; failure <= WEBHOOK_AUTO_DISABLE_THRESHOLD; failure += 1) {
      const r = await harness.deliver(sub.id, {
        deliveryId: randomUUID(),
        attempt: 1,
        maxAttempts: 1,
      });
      lastOutcome = r.outcome;
    }
    expect(lastOutcome).toBe('disabled');

    const disabled = await harness.reload(sub.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledReason).toBe('auto');
    expect(disabled.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);

    // The Control Center shows the auto-disabled state; the user re-enables it there.
    const page = owner.page;
    await page.goto('/control/webhooks');
    const row = page.getByRole('listitem').filter({ hasText: receiver.url });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('Auto-disabled')).toBeVisible();

    await row.getByRole('button', { name: 'Enable' }).click();
    await expect(row.getByText('Active')).toBeVisible({ timeout: 15_000 });

    // Re-enabling resets the whole failure state (enabled, reason cleared, streak 0).
    const reenabled = await harness.reload(sub.id);
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.disabledReason).toBeNull();
    expect(reenabled.consecutiveFailures).toBe(0);
  } finally {
    await harness.dispose();
    await receiver.close();
    await owner.context.close();
  }
});
