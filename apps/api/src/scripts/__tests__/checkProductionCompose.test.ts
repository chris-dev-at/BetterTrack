import { describe, expect, it } from 'vitest';

import { assertServiceLoggingLimits, type RenderedCompose } from '../checkProductionCompose';

const boundedLogging = {
  driver: 'local',
  options: {
    'max-size': '10m',
    'max-file': '3',
  },
};

describe('production Compose logging gate', () => {
  it('accepts a positive size and file limit on every rendered service', () => {
    const rendered: RenderedCompose = {
      services: {
        api: { logging: boundedLogging },
        worker: { logging: boundedLogging },
      },
    };

    expect(() => assertServiceLoggingLimits(rendered, 'test')).not.toThrow();
  });

  it('fails when any rendered service is missing logging limits', () => {
    const rendered: RenderedCompose = {
      services: {
        api: { logging: boundedLogging },
        worker: {},
      },
    };

    expect(() => assertServiceLoggingLimits(rendered, 'test')).toThrow(
      'test: rendered service "worker" must use the bounded local log driver',
    );
  });
});
