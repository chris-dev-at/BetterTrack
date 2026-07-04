import { describe, expect, it } from 'vitest';

import { friendAcceptedEmail, friendRequestEmail, portfolioSharedEmail } from '../templates';

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
});
