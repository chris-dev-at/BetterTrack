import { describe, expect, test } from 'vitest';

import {
  registerPathForAuthorize,
  safeAuthorizeContinuation,
  wantsRegisterScreen,
  withoutScreenHint,
} from './oauthContinuation';

/**
 * The open-redirect guard behind app-native registration (owner directive
 * 2026-08-07; §10). `returnTo` is an attacker-controllable query parameter, so
 * these cases are the contract: exactly one internal path is navigable, and
 * everything else fails closed.
 */

/** A realistic authorize request as the mobile app builds it (PKCE, first-party client). */
const AUTHORIZE =
  '/oauth/authorize?response_type=code&client_id=btc_IbT1mzw_7kBiPHPkGfaE0Q' +
  '&redirect_uri=bettertrack%3A%2F%2Foauth%2Fcallback&scope=portfolio%3Aread%20chat%3Awrite' +
  '&state=xyz123&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256';

describe('safeAuthorizeContinuation — accepts', () => {
  test('the authorize path with the full OAuth query, verbatim', () => {
    expect(safeAuthorizeContinuation(AUTHORIZE)).toBe(AUTHORIZE);
  });

  test('the bare authorize path, with or without a trailing slash', () => {
    expect(safeAuthorizeContinuation('/oauth/authorize')).toBe('/oauth/authorize');
    expect(safeAuthorizeContinuation('/oauth/authorize/')).toBe('/oauth/authorize/');
    expect(safeAuthorizeContinuation('/oauth/authorize/?client_id=a')).toBe(
      '/oauth/authorize/?client_id=a',
    );
  });

  test('an empty query string', () => {
    expect(safeAuthorizeContinuation('/oauth/authorize?')).toBe('/oauth/authorize?');
  });

  test('a query carrying an absolute redirect_uri — the query is never navigated to', () => {
    const withHttpRedirect =
      '/oauth/authorize?client_id=a&redirect_uri=https%3A%2F%2Fapp.test%2Fcb';
    expect(safeAuthorizeContinuation(withHttpRedirect)).toBe(withHttpRedirect);
  });
});

describe('safeAuthorizeContinuation — rejects', () => {
  test.each([
    ['an absolute http URL', 'https://evil.test/oauth/authorize'],
    ['an absolute http URL on our own host', 'https://bettertrack.at/oauth/authorize'],
    ['a scheme-less absolute URL', 'evil.test/oauth/authorize'],
    ['a protocol-relative URL', '//evil.test'],
    ['a protocol-relative URL that mimics the path', '//evil.test/oauth/authorize'],
    ['a triple-slash variant', '///evil.test/oauth/authorize'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a custom-scheme deep link', 'bettertrack://oauth/callback'],
    ['a backslash-smuggled origin', '/\\evil.test'],
    ['a backslash after the path', '/oauth/authorize\\@evil.test'],
    ['a mixed slash-backslash origin', '/\\/evil.test/oauth/authorize'],
    ['a relative path', 'oauth/authorize?client_id=a'],
    ['a parent-relative path', '../oauth/authorize'],
    ['the empty string', ''],
    ['a bare fragment', '#/oauth/authorize'],
    ['a fragment appended to the authorize path', '/oauth/authorize?client_id=a#/evil'],
  ])('%s', (_label, value) => {
    expect(safeAuthorizeContinuation(value)).toBeNull();
  });

  test.each([
    ['the app home', '/'],
    ['the login page', '/login'],
    ['the register page itself', '/register?returnTo=%2Foauth%2Fauthorize'],
    ['settings', '/settings/security'],
    ['a path that merely starts with the authorize path', '/oauth/authorizeX?client_id=a'],
    ['a deeper path under the authorize path', '/oauth/authorize/evil'],
    ['a sibling oauth path', '/oauth/token'],
    ['a traversal out of the authorize path', '/oauth/authorize/../../evil'],
    ['a percent-encoded traversal', '/oauth/authorize/%2e%2e/%2e%2e/evil'],
    ['a percent-encoded path separator', '/oauth%2Fauthorize?client_id=a'],
    ['a differently-cased path', '/OAuth/Authorize?client_id=a'],
  ])('%s (internal but not the authorize path)', (_label, value) => {
    expect(safeAuthorizeContinuation(value)).toBeNull();
  });

  test.each([
    ['a newline', '/oauth/authorize?client_id=a\nSet-Cookie: x=1'],
    ['a carriage return', '/oauth/authorize\r\n'],
    ['a tab', '/oauth/authorize\t?client_id=a'],
    ['a NUL byte', '/oauth/authorize\u0000/evil'],
    ['a raw space', '/oauth/authorize ?client_id=a'],
    ['a leading space before a protocol-relative URL', ' //evil.test'],
    ['a DEL byte', '/oauth/authorize\u007f'],
  ])('%s (control character or raw whitespace)', (_label, value) => {
    expect(safeAuthorizeContinuation(value)).toBeNull();
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('%s', (_label, value) => {
    expect(safeAuthorizeContinuation(value)).toBeNull();
  });
});

describe('withoutScreenHint', () => {
  test('leaves a URL without the hint byte-identical', () => {
    expect(withoutScreenHint(AUTHORIZE)).toBe(AUTHORIZE);
    expect(withoutScreenHint('/oauth/authorize')).toBe('/oauth/authorize');
  });

  test('drops only the screen parameter and keeps state + PKCE', () => {
    const stripped = withoutScreenHint(`${AUTHORIZE}&screen=register`);
    expect(stripped).not.toContain('screen=');
    const query = new URLSearchParams(stripped.slice(stripped.indexOf('?') + 1));
    expect(query.get('state')).toBe('xyz123');
    expect(query.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(query.get('redirect_uri')).toBe('bettertrack://oauth/callback');
    expect(query.get('scope')).toBe('portfolio:read chat:write');
  });

  test('drops a trailing question mark when the hint was the only parameter', () => {
    expect(withoutScreenHint('/oauth/authorize?screen=register')).toBe('/oauth/authorize');
  });
});

describe('wantsRegisterScreen', () => {
  test('true only for screen=register on a safe authorize URL', () => {
    expect(wantsRegisterScreen(`${AUTHORIZE}&screen=register`)).toBe(true);
  });

  test.each([
    ['no hint at all', AUTHORIZE],
    ['an unknown hint', `${AUTHORIZE}&screen=signup`],
    ['an empty hint', `${AUTHORIZE}&screen=`],
    ['a differently-cased hint', `${AUTHORIZE}&screen=Register`],
    ['no query at all', '/oauth/authorize'],
  ])('false for %s', (_label, value) => {
    expect(wantsRegisterScreen(value)).toBe(false);
  });

  test('false when the hint rides an unsafe URL — the guard runs first', () => {
    expect(wantsRegisterScreen('https://evil.test/oauth/authorize?screen=register')).toBe(false);
    expect(wantsRegisterScreen('//evil.test/oauth/authorize?screen=register')).toBe(false);
    expect(wantsRegisterScreen('/login?screen=register')).toBe(false);
  });
});

describe('registerPathForAuthorize', () => {
  test('encodes the continuation into returnTo and strips the screen hint', () => {
    const href = registerPathForAuthorize(`${AUTHORIZE}&screen=register`);
    expect(href.startsWith('/register?returnTo=')).toBe(true);

    const returnTo = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('returnTo');
    // Round-trips back through the guard, without the hint that would loop.
    expect(safeAuthorizeContinuation(returnTo)).toBe(returnTo);
    expect(returnTo).not.toContain('screen=');
    expect(wantsRegisterScreen(returnTo)).toBe(false);
  });

  test('degrades to plain /register for anything the guard refuses', () => {
    expect(registerPathForAuthorize('https://evil.test')).toBe('/register');
    expect(registerPathForAuthorize('//evil.test')).toBe('/register');
    expect(registerPathForAuthorize('/settings')).toBe('/register');
    expect(registerPathForAuthorize(null)).toBe('/register');
  });
});
