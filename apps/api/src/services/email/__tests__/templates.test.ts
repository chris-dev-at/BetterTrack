import { describe, expect, it } from 'vitest';

import {
  alertTriggeredEmail,
  deferredNotificationEmail,
  digestEmail,
  friendAcceptedEmail,
  friendRequestEmail,
  portfolioSharedEmail,
  standingOrderSkippedEmail,
} from '../templates';

const APP_URL = 'https://bt.example.test';

/** The notification templates (PROJECTPLAN.md §6.10) render clean HTML + text. */
describe('notification email templates (§6.10)', () => {
  it('friendRequestEmail names the actor and links the app', () => {
    const email = friendRequestEmail({ actorUsername: 'alice', appUrl: APP_URL });
    expect(email.subject).toMatch(/friend request/i);
    expect(email.html).toContain('<html');
    expect(email.html).toContain('alice');
    expect(email.html).toContain(APP_URL);
    expect(email.text).toContain('alice');
    expect(email.text).toContain(APP_URL);
  });

  it('friendAcceptedEmail names the actor', () => {
    const email = friendAcceptedEmail({ actorUsername: 'bob', appUrl: APP_URL });
    expect(email.subject).toMatch(/bob/);
    expect(email.html).toContain('bob');
    expect(email.text).toContain('bob');
  });

  it('portfolioSharedEmail names the actor', () => {
    const email = portfolioSharedEmail({ actorUsername: 'carol', appUrl: APP_URL });
    expect(email.subject).toMatch(/carol/);
    expect(email.html).toContain('carol');
    expect(email.text).toContain('carol');
  });

  it('escapes HTML-significant characters in the actor name', () => {
    const email = friendRequestEmail({ actorUsername: '<script>x</script>', appUrl: APP_URL });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('standingOrderSkippedEmail localizes the outcome and deep-links to the exact order', () => {
    const email = standingOrderSkippedEmail({
      standingOrderId: 'so-1',
      orderLabel: 'Netflix <bill>',
      periodKey: '2026-04-01',
      outcome: 'dropped',
      droppedCount: 3,
      appUrl: APP_URL,
      locale: 'de',
    });
    expect(email.subject).toBe('3 Dauerauftrags-Ausführungen wurden übersprungen');
    expect(email.html).toContain('<html lang="de">');
    expect(email.html).toContain('Netflix &lt;bill&gt;');
    expect(email.html).toContain(`${APP_URL}/workbench/forecasts#standing-order-so-1`);
    expect(email.text).toContain('2026-04-01');
  });

  /**
   * The deferred/digest heading is built from user-supplied data (a chain name,
   * a budget tag, a custom asset's symbol) and used to be interpolated raw
   * (#1816) — the same guarantee `friendRequestEmail` has above.
   */
  describe('deferred + digest titles are inert (#1816)', () => {
    // 99 chars, so it passes `chainNameSchema` (trim, min 1, max 120).
    const PAYLOAD = '</td></tr><tr><td><a href="https://evil.example">Reset your password</a>';

    it('escapes a caller-supplied title in deferredNotificationEmail', () => {
      const email = deferredNotificationEmail({
        title: PAYLOAD,
        body: 'Somebody joined the chain.',
        appUrl: APP_URL,
      });
      expect(email.html).not.toContain('href="https://evil.example"');
      expect(email.html).not.toContain('</td></tr><tr><td><a');
      expect(email.html).toContain('&lt;/td&gt;&lt;/tr&gt;');
      expect(email.html).toContain('&quot;https://evil.example&quot;');
      // Exactly one anchor survives: the template's own button.
      expect(email.html.match(/<a /g) ?? []).toHaveLength(1);
    });

    it('escapes item titles and bodies in digestEmail', () => {
      const email = digestEmail({
        cadence: 'daily',
        items: [{ title: PAYLOAD, body: PAYLOAD }],
        appUrl: APP_URL,
      });
      expect(email.html).not.toContain('href="https://evil.example"');
      expect(email.html).toContain('&lt;/td&gt;&lt;/tr&gt;');
      expect(email.html.match(/<a /g) ?? []).toHaveLength(1);
    });

    it('keeps a heading with HTML-significant characters readable, not double-escaped', () => {
      const email = alertTriggeredEmail({
        symbol: 'A&B',
        body: 'A&B crossed above 10.',
        appUrl: APP_URL,
      });
      expect(email.html).toContain('A&amp;B');
      expect(email.html).not.toContain('A&amp;amp;B');
    });
  });
});

/** Notification emails render in the recipient's locale (§13.3 V3-P1). */
describe('notification email localization (§13.3 V3-P1)', () => {
  it('renders German copy and lang for a de recipient, still naming the actor', () => {
    const email = friendRequestEmail({ actorUsername: 'alice', appUrl: APP_URL, locale: 'de' });
    expect(email.subject).toBe('Neue Freundschaftsanfrage auf BetterTrack');
    expect(email.html).toContain('<html lang="de">');
    expect(email.html).toContain('Freundschaftsanfrage');
    expect(email.html).toContain('alice');
    expect(email.text).toContain('Freundschaftsanfrage');
  });

  it('renders English for an en recipient (the default source of truth)', () => {
    const email = friendRequestEmail({ actorUsername: 'alice', appUrl: APP_URL, locale: 'en' });
    expect(email.subject).toBe('New friend request on BetterTrack');
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('sent you a friend request');
  });

  it('falls back to English for an unknown / untranslated locale', () => {
    const email = friendRequestEmail({ actorUsername: 'alice', appUrl: APP_URL, locale: 'fr' });
    expect(email.subject).toBe('New friend request on BetterTrack');
    expect(email.html).toContain('<html lang="en">');
  });

  it('localizes the price-alert subject while keeping the alert sentence intact', () => {
    const email = alertTriggeredEmail({
      symbol: 'BTC-EUR',
      body: 'BTC-EUR crossed above 50.000,00 €.',
      appUrl: APP_URL,
      locale: 'de',
    });
    expect(email.subject).toBe('Preisalarm: BTC-EUR');
    expect(email.html).toContain('<html lang="de">');
    // The dynamically-built alert sentence is passed through verbatim.
    expect(email.html).toContain('BTC-EUR crossed above 50.000,00 €.');
  });
});
