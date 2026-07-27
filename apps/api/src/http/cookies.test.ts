import type { CookieOptions, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../config/env';

import {
  clearGoogleOAuthStateCookie,
  clearGoogleRegisterTicketCookie,
  clearRememberedDeviceCookie,
  clearSessionCookie,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE_MS,
  GOOGLE_REGISTER_TICKET_COOKIE,
  GOOGLE_REGISTER_TICKET_MAX_AGE_MS,
  REMEMBERED_DEVICE_COOKIE,
  REMEMBERED_DEVICE_MAX_AGE_MS,
  setGoogleOAuthStateCookie,
  setGoogleRegisterTicketCookie,
  setRememberedDeviceCookie,
  setSessionCookie,
} from './cookies';

const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://cookies-test',
  REDIS_URL: 'redis://cookies-test',
  SESSION_SECRET: 'cookies-test-secret-at-least-sixteen-characters',
};

type CookieSetter = (name: string, value: string, options: CookieOptions) => Response;
type CookieClearer = (name: string, options?: CookieOptions) => Response;

function responseSpy() {
  const cookie = vi.fn<CookieSetter>();
  const clearCookie = vi.fn<CookieClearer>();

  return {
    response: { cookie, clearCookie } as unknown as Response,
    cookie,
    clearCookie,
  };
}

function config(secure: boolean): AppConfig {
  const base = loadConfig({
    ...REQUIRED_ENV,
    BT_MODE: 'ports',
    BT_DOMAIN: 'cookies.test',
    BT_TLS: String(secure),
  });

  return {
    ...base,
    cookie: {
      ...base.cookie,
      name: 'configured-session-cookie',
    },
  };
}

function securityOptions(appConfig: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: appConfig.cookie.sameSite,
    secure: appConfig.cookie.secure,
    signed: true,
    path: '/',
  };
}

function expectNoLifetime(options: CookieOptions): void {
  expect(options).not.toHaveProperty('maxAge');
  expect(options).not.toHaveProperty('expires');
}

interface FixedLifetimeCookie {
  label: string;
  name: string;
  maxAge: number;
  value: string;
  set: (res: Response, appConfig: AppConfig, value: string) => void;
  clear: (res: Response, appConfig: AppConfig) => void;
}

const FIXED_LIFETIME_COOKIES: FixedLifetimeCookie[] = [
  {
    label: 'remembered device',
    name: REMEMBERED_DEVICE_COOKIE,
    maxAge: REMEMBERED_DEVICE_MAX_AGE_MS,
    value: 'device-id',
    set: setRememberedDeviceCookie,
    clear: clearRememberedDeviceCookie,
  },
  {
    label: 'Google OAuth state',
    name: GOOGLE_OAUTH_STATE_COOKIE,
    maxAge: GOOGLE_OAUTH_STATE_MAX_AGE_MS,
    value: 'oauth-state',
    set: setGoogleOAuthStateCookie,
    clear: clearGoogleOAuthStateCookie,
  },
  {
    label: 'Google registration ticket',
    name: GOOGLE_REGISTER_TICKET_COOKIE,
    maxAge: GOOGLE_REGISTER_TICKET_MAX_AGE_MS,
    value: 'registration-ticket',
    set: setGoogleRegisterTicketCookie,
    clear: clearGoogleRegisterTicketCookie,
  },
];

describe('cookie helpers', () => {
  it.each([false, true])('uses matching session security attributes for secure=%s', (secure) => {
    const appConfig = config(secure);
    const persistent = responseSpy();
    const browserSession = responseSpy();
    const cleared = responseSpy();

    setSessionCookie(persistent.response, appConfig, 'persistent-session', true);
    setSessionCookie(browserSession.response, appConfig, 'browser-session', false);
    clearSessionCookie(cleared.response, appConfig);

    expect(persistent.cookie).toHaveBeenCalledOnce();
    expect(persistent.cookie).toHaveBeenCalledWith(appConfig.cookie.name, 'persistent-session', {
      ...securityOptions(appConfig),
      maxAge: appConfig.cookie.maxAgeMs,
    });
    expect(browserSession.cookie).toHaveBeenCalledOnce();
    expect(browserSession.cookie).toHaveBeenCalledWith(
      appConfig.cookie.name,
      'browser-session',
      securityOptions(appConfig),
    );
    expectNoLifetime(browserSession.cookie.mock.calls[0]![2]);

    expect(cleared.clearCookie).toHaveBeenCalledOnce();
    expect(cleared.clearCookie).toHaveBeenCalledWith(
      appConfig.cookie.name,
      securityOptions(appConfig),
    );
    expectNoLifetime(cleared.clearCookie.mock.calls[0]![1]!);
  });

  it.each([false, true])(
    'sets and clears fixed-lifetime cookies with matching attributes for secure=%s',
    (secure) => {
      const appConfig = config(secure);

      for (const fixture of FIXED_LIFETIME_COOKIES) {
        const set = responseSpy();
        const cleared = responseSpy();

        fixture.set(set.response, appConfig, fixture.value);
        fixture.clear(cleared.response, appConfig);

        expect(set.cookie, fixture.label).toHaveBeenCalledOnce();
        expect(set.cookie, fixture.label).toHaveBeenCalledWith(fixture.name, fixture.value, {
          ...securityOptions(appConfig),
          maxAge: fixture.maxAge,
        });
        expect(cleared.clearCookie, fixture.label).toHaveBeenCalledOnce();
        expect(cleared.clearCookie, fixture.label).toHaveBeenCalledWith(
          fixture.name,
          securityOptions(appConfig),
        );
        expectNoLifetime(cleared.clearCookie.mock.calls[0]![1]!);
      }
    },
  );
});
