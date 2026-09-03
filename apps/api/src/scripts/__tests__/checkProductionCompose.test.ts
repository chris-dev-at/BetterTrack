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

function bootstrapScript(overrides: { body?: string } = {}): string[] {
  return [
    '/bin/sh',
    '-c',
    overrides.body ??
      `cred=${credentialFile}\n` +
        "case \"$supplied\" in '' | admin | change_me_before_first_boot) supplied='' ;; esac\n" +
        'head -c 4096 /dev/urandom | tr -dc "A-Za-z0-9" | cut -c1-32\n' +
        'grafana cli admin reset-admin-password "$(cat "$cred")"\n' +
        'exec /run.sh\n',
  ];
}

const bootstrapEntrypoint = bootstrapScript();

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
        // Even a strong literal is refused: the key itself is the regression.
        GF_SECURITY_ADMIN_PASSWORD: 'a-strong-inline-literal',
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
      // What `GF_SECURITY_ADMIN_PASSWORD: '${BT_GRAFANA_ADMIN_PASSWORD:-admin}'`
      // renders to with the variable unset — the exact shape issue #1698 closed.
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

  it('fails when the entrypoint stops refusing the known-unsafe literals, so it could seed `admin` itself', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile },
      entrypoint: bootstrapScript({
        body:
          `cred=${credentialFile}\n` +
          'head -c 4096 /dev/urandom | tr -dc "A-Za-z0-9" | cut -c1-32\n' +
          'grafana cli admin reset-admin-password "$(cat "$cred")"\n' +
          'exec /run.sh\n',
      }),
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: the grafana entrypoint must keep refusing the known-unsafe credentials',
    );
  });

  it('fails when the entrypoint exports GF_SECURITY_ADMIN_PASSWORD next to the __FILE variant (run.sh refuses both)', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile },
      entrypoint: bootstrapScript({
        body:
          `cred=${credentialFile}\n` +
          "case \"$supplied\" in '' | admin | change_me_before_first_boot) supplied='' ;; esac\n" +
          'head -c 4096 /dev/urandom | tr -dc "A-Za-z0-9" | cut -c1-32\n' +
          'grafana cli admin reset-admin-password "$(cat "$cred")"\n' +
          'GF_SECURITY_ADMIN_PASSWORD="$(cat "$cred")"\n' +
          'export GF_SECURITY_ADMIN_PASSWORD\n' +
          'exec /run.sh\n',
      }),
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: the grafana entrypoint must not set GF_SECURITY_ADMIN_PASSWORD',
    );
  });

  it('fails when the entrypoint never applies the credential to an already-provisioned grafana.db', () => {
    const rendered = grafanaCompose({
      environment: { GF_SECURITY_ADMIN_PASSWORD__FILE: credentialFile },
      entrypoint: bootstrapScript({
        body:
          `cred=${credentialFile}\n` +
          "case \"$supplied\" in '' | admin | change_me_before_first_boot) supplied='' ;; esac\n" +
          'head -c 4096 /dev/urandom | tr -dc "A-Za-z0-9" | cut -c1-32\n' +
          'exec /run.sh\n',
      }),
    });

    expect(() => assertGrafanaAdminCredential(rendered, 'test')).toThrow(
      'test: the grafana entrypoint must apply /var/lib/grafana/.bettertrack-admin-password to an already-provisioned grafana.db',
    );
  });
});
