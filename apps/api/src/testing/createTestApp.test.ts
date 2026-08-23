import { describe, expect, it } from 'vitest';

import { createTestApp } from './createTestApp';

describe('createTestApp disposal', () => {
  it('keeps Redis available to a second harness after the first is disposed', async () => {
    const first = await createTestApp();
    const second = await createTestApp();

    try {
      await first.dispose();
      await expect(second.ctx.redis.ping()).resolves.toBe('PONG');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
