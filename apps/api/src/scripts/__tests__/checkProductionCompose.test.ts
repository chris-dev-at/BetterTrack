import { describe, expect, it } from 'vitest';

import {
  assertGrafanaAdminCredential,
  assertServiceLoggingLimits,
  type RenderedCompose,
} from '../checkProductionCompose';

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

const credentialFile = '/var/lib/grafana/.bettertrack-admin-password';

function grafanaCompose(service: Record<string, unknown>): RenderedCompose {
  return { services: { grafana: service } } as RenderedCompose;
}

const bootstrapEntrypoint = [
  '/bin/sh',
  '-c',
  `cred="\${GF_SECURITY_ADMIN_PASSWORD__FILE:-${credentialFile}}"\n` +
    'head -c 4096 /dev/urandom | tr -dc "A-Za-z0-9" | cut -c1-32\nexec /run.sh\n',
];

describe('production Compose Grafana credential gate', () => {
  it('accepts the shipped shape: a file-backed credential seeded by the bootstrap entrypoint', () => {
    const rendered = grafanaCompose({
      environment: {
        GF_SECURITY_ADMIN_USER: 'admin',
        GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile,
        BT_GRAFANA_ADMIN_PASSWORD: 'CHANGE_ME_BEFORE_FIRST_BOOT',
      },
      entrypoint: bootstrapEntrypoint,
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).not.toThrow();
  });

  it('fails when the compose file reintroduces a hardcoded admin password', () => {
    const rendered = grafanaCompose({
      environment: {
        GF_SECURITY_ADMIN_PASSWORD: 'admin',
        GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile,
      },
      entrypoint: bootstrapEntrypoint,
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: grafana must not carry an inline GF_SECURITY_ADMIN_PASSWORD',
    );
  });

  it('fails when a defaulted admin password renders (${BT_GRAFANA_ADMIN_PASSWORD:-admin} with the var unset)', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD: '', GF_SECURITY_ADMIN_PASSWORD__FILE: '' },
      entrypoint: bootstrapEntrypoint,
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: grafana must not carry an inline GF_SECURITY_ADMIN_PASSWORD',
    );
  });

  it('fails when another GF_ variable smuggles a known-unsafe credential in', () => {
    const rendered = grafanaCompose({
      environment: {
        GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile,
        GF_SECURITY_ADMIN_PASSWORD_FALLBACK: ' Admin ',
      },
      entrypoint: bootstrapEntrypoint,
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: grafana renders a known-unsafe credential for GF_SECURITY_ADMIN_PASSWORD_FALLBACK',
    );
  });

  it('fails when the credential file is not an absolute path', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: 'admin-password' },
      entrypoint: bootstrapEntrypoint,
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: grafana must point GF_SECURITY_ADMIN_PASSWORD__FILE at an absolute credential path',
    );
  });

  it('fails when the bootstrap entrypoint is dropped, so nothing would seed the file', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile },
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: grafana must keep the credential bootstrap entrypoint',
    );
  });

  it('fails when the entrypoint no longer generates a credential of its own', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile },
      entrypoint: ['/bin/sh', '-c', `cat ${credentialFile}\nexec /run.sh\n`],
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: the grafana entrypoint must generate a random credential when none is supplied',
    );
  });
});
