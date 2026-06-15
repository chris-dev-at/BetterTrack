import { describe, expect, it } from 'vitest';

import { ApiError } from '../../errors';
import { createProviderRegistry } from '../registry';

import { createFakeProvider } from './fakeProvider';

describe('createProviderRegistry', () => {
  it('registers and resolves providers by id and by asset ref', () => {
    const yahoo = createFakeProvider('yahoo');
    const manual = createFakeProvider('manual');
    const registry = createProviderRegistry([yahoo, manual]);

    expect(registry.has('yahoo')).toBe(true);
    expect(registry.get('manual')).toBe(manual);
    expect(registry.for({ providerId: 'yahoo' })).toBe(yahoo);
    expect(registry.ids().sort()).toEqual(['manual', 'yahoo']);
    expect(registry.all()).toHaveLength(2);
  });

  it('throws PROVIDER_NOT_FOUND for an unknown provider', () => {
    const registry = createProviderRegistry();
    try {
      registry.get('nope');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('PROVIDER_NOT_FOUND');
      expect((err as ApiError).statusCode).toBe(500);
    }
  });

  it('rejects a duplicate provider id', () => {
    const registry = createProviderRegistry([createFakeProvider('yahoo')]);
    expect(() => registry.register(createFakeProvider('yahoo'))).toThrowError(/already registered/);
  });
});
