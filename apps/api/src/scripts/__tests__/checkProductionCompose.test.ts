import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertGrafanaAdminCredential,
  assertGrafanaAnonymousAccessBind,
  assertGrafanaTelemetryDisabled,
  assertLanObservabilityBind,
  assertPrometheusExposure,
  assertServiceLoggingLimits,
  GRAFANA_TELEMETRY_SETTINGS,
  PROMETHEUS_FORBIDDEN_FLAGS,
  PROMETHEUS_HEALTH_PROBE_PATH,
  PROMETHEUS_LIFECYCLE_GATED_PATHS,
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

const telemetryOff: Record<string, string> = { ...GRAFANA_TELEMETRY_SETTINGS };
const telemetryEntries = Object.entries(GRAFANA_TELEMETRY_SETTINGS);

describe('production Compose Grafana telemetry gate', () => {
  it('accepts the shipped shape: every outbound-call setting pinned off', () => {
    const rendered = grafanaCompose({ environment: { ...telemetryOff } });

    expect(() => assertGrafanaTelemetryDisabled(rendered, 'test')).not.toThrow();
  });

  it('names each setting it covers, so a reviewer can check the compose file against it', () => {
    // Polarities differ: the gravatar switch is "disable", so its safe value is
    // `true` while the analytics/news ones are `false`.
    expect(GRAFANA_TELEMETRY_SETTINGS).toEqual({
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
      GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: 'false',
      GF_NEWS_NEWS_FEED_ENABLED: 'false',
      GF_SECURITY_DISABLE_GRAVATAR: 'true',
    });
  });

  it.each(telemetryEntries)(
    'fails when %s is dropped (Grafana defaults it the other way)',
    (key) => {
      const environment = { ...telemetryOff };
      delete environment[key];

      expect(() => assertGrafanaTelemetryDisabled(grafanaCompose({ environment }), 'test')).toThrow(
        `test: grafana must set ${key}`,
      );
    },
  );

  it.each(telemetryEntries)(
    'fails when %s is flipped back to the calling-out value',
    (key, required) => {
      const flipped = required === 'false' ? 'true' : 'false';
      const rendered = grafanaCompose({ environment: { ...telemetryOff, [key]: flipped } });

      expect(() => assertGrafanaTelemetryDisabled(rendered, 'test')).toThrow(
        `test: grafana must keep ${key} at ${required} — it renders "${flipped}"`,
      );
    },
  );
});

const anonymousGuardEntrypoint = [
  '/bin/sh',
  '-c',
  'anon="${GF_AUTH_ANONYMOUS_ENABLED:-false}"\n' +
    'bind="${BT_OBS_BIND_HOST:-127.0.0.1}"\n' +
    'ack="${BT_GRAFANA_ANON_LAN_ACK:-}"\n' +
    'if [ "$anon" = yes ] && [ "$loopback" = no ] && [ "$ack" = no ]; then\n' +
    '  echo "bettertrack: refusing to start Grafana with anonymous access on the non-loopback bind $bind." >&2\n' +
    '  exit 1\n' +
    'fi\n' +
    'exec /run.sh\n',
];

// The three key names appear in the real entrypoint's explanatory comments too,
// so this is what a guard reduced to prose looks like: every name present, no
// comparison left.
const commentOnlyGuardEntrypoint = [
  '/bin/sh',
  '-c',
  '# GF_AUTH_ANONYMOUS_ENABLED on a non-loopback BT_OBS_BIND_HOST used to be\n' +
    '# refused here unless BT_GRAFANA_ANON_LAN_ACK named the exposure.\n' +
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

  it('fails when the guard is gutted down to the comments that name its keys', () => {
    const rendered = anonymousCompose({ entrypoint: commentOnlyGuardEntrypoint });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      "test: the grafana entrypoint must keep the anonymous-access guard's refusal",
    );
  });

  it.each(['t', 'y'])('treats %s as anonymous access on, the way go-ini parseBool does', (flag) => {
    const rendered = anonymousCompose({ anonymous: flag, bindHost: '192.168.1.10' });

    expect(() => assertGrafanaAnonymousAccessBind(rendered, 'test')).toThrow(
      'test: grafana renders anonymous access on the non-loopback bind 192.168.1.10',
    );
  });
});

const prometheusCommand = [
  '--config.file=/etc/prometheus/prometheus.yml',
  '--storage.tsdb.path=/prometheus',
  '--storage.tsdb.retention.time=15d',
];

function prometheusCompose(
  overrides: { command?: unknown; entrypoint?: unknown; ports?: unknown[] } = {},
): RenderedCompose {
  return {
    services: {
      prometheus: {
        command: overrides.command ?? prometheusCommand,
        ...(overrides.entrypoint === undefined ? {} : { entrypoint: overrides.entrypoint }),
        ports: overrides.ports ?? [{ target: 9090, host_ip: '127.0.0.1' }],
      },
    },
  } as RenderedCompose;
}

describe('production Compose Prometheus exposure gate', () => {
  it('accepts the shipped shape: no write-endpoint flags, published on loopback only', () => {
    expect(() => assertPrometheusExposure(prometheusCompose(), 'test')).not.toThrow();
  });

  it.each([...PROMETHEUS_FORBIDDEN_FLAGS])('fails when %s comes back in the command', (flag) => {
    const rendered = prometheusCompose({ command: [...prometheusCommand, flag] });

    expect(() => assertPrometheusExposure(rendered, 'test')).toThrow(
      `test: prometheus must not run with ${flag}`,
    );
  });

  it('fails when a write-endpoint flag is smuggled through an entrypoint override', () => {
    const rendered = prometheusCompose({
      entrypoint: ['/bin/prometheus', '--web.enable-lifecycle'],
      command: prometheusCommand,
    });

    expect(() => assertPrometheusExposure(rendered, 'test')).toThrow(
      'test: prometheus must not run with --web.enable-lifecycle',
    );
  });

  it('fails when the bind follows the LAN recipe onto the network', () => {
    const rendered = prometheusCompose({ ports: [{ target: 9090, host_ip: '192.168.1.10' }] });

    expect(() => assertPrometheusExposure(rendered, 'test')).toThrow(
      'test: prometheus publishes on the non-loopback bind 192.168.1.10',
    );
  });

  it('fails when the port is published on every interface', () => {
    const rendered = prometheusCompose({ ports: [{ target: 9090 }] });

    expect(() => assertPrometheusExposure(rendered, 'test')).toThrow(
      'test: prometheus publishes on the non-loopback bind (all interfaces)',
    );
  });

  it.each(['localhost', '::1', '127.0.1.1'])('accepts the loopback bind %s', (host) => {
    const rendered = prometheusCompose({ ports: [{ target: 9090, host_ip: host }] });

    expect(() => assertPrometheusExposure(rendered, 'test')).not.toThrow();
  });

  it('keeps the admin health probe off the endpoints the dropped flag gated', () => {
    // The flag removal is only safe because `/-/healthy` is served either way;
    // this is the assertion that couples the two if the probe path ever moves.
    const monitoringService = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../services/observability/monitoringService.ts',
      ),
      'utf8',
    );

    expect(monitoringService).toContain(`'${PROMETHEUS_HEALTH_PROBE_PATH}'`);
    expect(PROMETHEUS_LIFECYCLE_GATED_PATHS).not.toContain(PROMETHEUS_HEALTH_PROBE_PATH);
  });
});

describe('production Compose LAN observability-bind probe', () => {
  const lanBind = '192.168.242.10';

  it('accepts the render where the LAN bind moved Grafana', () => {
    const rendered = grafanaCompose({ ports: [{ target: 3000, host_ip: lanBind }] });

    expect(() => assertLanObservabilityBind(rendered, 'test', lanBind)).not.toThrow();
  });

  it('fails when the probe no longer moves Grafana, so the render proves nothing', () => {
    const rendered = grafanaCompose({ ports: [{ target: 3000, host_ip: '127.0.0.1' }] });

    expect(() => assertLanObservabilityBind(rendered, 'test', lanBind)).toThrow(
      'test: the LAN-bind probe did not take',
    );
  });
});
