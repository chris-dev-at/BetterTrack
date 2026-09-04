import { describe, expect, it } from 'vitest';

import {
  assertGrafanaAdminCredential,
  assertGrafanaAnonymousAccessBind,
  assertGrafanaTelemetryDisabled,
  assertServiceLoggingLimits,
  GRAFANA_TELEMETRY_SETTINGS,
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

const telemetryOff = Object.fromEntries(GRAFANA_TELEMETRY_SETTINGS.map((key) => [key, 'false']));

describe('production Compose Grafana telemetry gate', () => {
  it('accepts the shipped shape: every phone-home setting pinned off', () => {
    const rendered = grafanaCompose({ environment: { ...telemetryOff } });

    expect(() => assertGrafanaTelemetryDisabled(rendered, 'test')).not.toThrow();
  });

  it('names each setting it covers, so a reviewer can check the compose file against it', () => {
    expect([...GRAFANA_TELEMETRY_SETTINGS]).toEqual([
      'GF_ANALYTICS_REPORTING_ENABLED',
      'GF_ANALYTICS_CHECK_FOR_UPDATES',
      'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES',
      'GF_ANALYTICS_FEEDBACK_LINKS_ENABLED',
      'GF_NEWS_NEWS_FEED_ENABLED',
    ]);
  });

  it.each(GRAFANA_TELEMETRY_SETTINGS)(
    'fails when %s is dropped (Grafana defaults it to true)',
    (key) => {
      const environment = { ...telemetryOff };
      delete environment[key];

      expect(() => assertGrafanaTelemetryDisabled(grafanaCompose({ environment }), 'test')).toThrow(
        `test: grafana must set ${key}`,
      );
    },
  );

  it.each(GRAFANA_TELEMETRY_SETTINGS)('fails when %s is flipped back on', (key) => {
    const rendered = grafanaCompose({ environment: { ...telemetryOff, [key]: 'true' } });

    expect(() => assertGrafanaTelemetryDisabled(rendered, 'test')).toThrow(
      `test: grafana must keep ${key} disabled — it renders "true"`,
    );
  });
});

const anonymousGuardEntrypoint = [
  '/bin/sh',
  '-c',
  'anon="${GF_AUTH_ANONYMOUS_ENABLED:-false}"\n' +
    'bind="${BT_OBS_BIND_HOST:-127.0.0.1}"\n' +
    'ack="${BT_GRAFANA_ANON_LAN_ACK:-}"\n' +
    'exec /run.sh\n',
];

function anonymousCompose(
  overrides: {
    anonymous?: string;
    role?: string;
    bindHost?: string;
    acknowledgement?: string;
    entrypoint?: unknown;
    ports?: unknown[];
  } = {},
): RenderedCompose {
  return grafanaCompose({
    environment: {
      GF_AUTH_ANONYMOUS_ENABLED: overrides.anonymous ?? 'false',
      GF_AUTH_ANONYMOUS_ORG_ROLE: overrides.role ?? 'Viewer',
      BT_OBS_BIND_HOST: overrides.bindHost ?? '127.0.0.1',
      BT_GRAFANA_ANON_LAN_ACK: overrides.acknowledgement ?? '',
    },
    entrypoint: overrides.entrypoint ?? anonymousGuardEntrypoint,
    ports: overrides.ports ?? [{ target: 3000, host_ip: overrides.bindHost ?? '127.0.0.1' }],
  });
}

describe('production Compose Grafana anonymous-access × bind-host gate', () => {
  it('accepts the shipped default: anonymous access off on the loopback bind', () => {
    expect(() => assertGrafanaAnonymousAccessBind(anonymousCompose(), 'test')).not.toThrow();
  });

  it('accepts the documented admin-proxy recipe: an anonymous Viewer on the loopback bind', () => {
    const rendered = anonymousCompose({ anonymous: 'true', bindHost: '127.0.0.1' });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).not.toThrow();
  });

  it('accepts a LAN bind on its own, with Grafana keeping its own login', () => {
    const rendered = anonymousCompose({ anonymous: 'false', bindHost: '192.168.1.10' });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).not.toThrow();
  });

  it('fails on the dangerous combination: an anonymous Viewer answering on a LAN bind', () => {
    const rendered = anonymousCompose({ anonymous: 'true', bindHost: '192.168.1.10' });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: grafana renders anonymous access on the non-loopback bind 192.168.1.10',
    );
  });

  it('fails when anonymous access meets a wildcard bind that publishes on every interface', () => {
    const rendered = anonymousCompose({
      anonymous: 'yes',
      bindHost: '0.0.0.0',
      ports: [{ target: 3000 }],
    });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: grafana renders anonymous access on the non-loopback bind (all interfaces)',
    );
  });

  it('allows the combination only when it is named explicitly', () => {
    const rendered = anonymousCompose({
      anonymous: 'true',
      bindHost: '192.168.1.10',
      acknowledgement: 'true',
    });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).not.toThrow();
  });

  it('fails when anonymous access renders a role above Viewer', () => {
    const rendered = anonymousCompose({ anonymous: 'true', role: 'Editor' });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: anonymous Grafana access must stay read-only',
    );
  });

  it('fails when the bind host is no longer handed to the entrypoint guard', () => {
    const rendered = grafanaCompose({
      environment: { GF_AUTH_ANONYMOUS_ENABLED: 'false', BT_GRAFANA_ANON_LAN_ACK: '' },
      entrypoint: anonymousGuardEntrypoint,
      ports: [{ target: 3000, host_ip: '127.0.0.1' }],
    });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: grafana must receive BT_OBS_BIND_HOST',
    );
  });

  it('fails when the entrypoint drops the guard, so only the shipped defaults would be safe', () => {
    const rendered = anonymousCompose({
      entrypoint: ['/bin/sh', '-c', 'exec /run.sh\n'],
    });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: the grafana entrypoint must keep the anonymous-access guard',
    );
  });
});
