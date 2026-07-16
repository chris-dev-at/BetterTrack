/**
 * Fake Google IdP for the Playwright Google-login spec (issue #520, §13.4 V4-P11).
 *
 * A minimal OAuth 2.0 / OIDC authorization-code stand-in that lets the REAL
 * BetterTrack Google flow run end-to-end under Playwright with zero network and
 * zero real Google credentials. Test infra only — it lives under `e2e/**` and
 * touches no app source. Three production endpoints (authorize / token / JWKS)
 * are pointed at this server via the API's test-only `BT_GOOGLE_*` overrides; the
 * API's own signature/`iss`/`aud`/`exp` verification runs UNMODIFIED against it.
 *
 * How the redirect chain stays cookie-safe: the API sets the single-use
 * `bt_goog_state` cookie at `/auth/google/start`, which the browser reached
 * through the web dev-server proxy (the web origin). For the callback to carry
 * that host-only cookie back, this IdP bounces the browser to the callback on the
 * WEB origin (`E2E_GOOGLE_CALLBACK_ORIGIN`) — the same host — rather than the
 * API's own `redirect_uri` origin, which would drop the cookie. The API's
 * server-side token + JWKS fetches hit this server directly (no browser), so
 * those need no such care.
 *
 * Endpoints:
 *   POST /__identity   prime the identity the NEXT authorize will mint a code for
 *                      (JSON: { sub, email, email_verified?, name? })
 *   GET  /authorize    bounce straight back to the callback with `code` + `state`
 *   POST /token        exchange the code for a jose-signed `id_token`
 *   GET  /jwks         the per-run public signing key (RS256)
 *   GET  /health       readiness probe for Playwright's webServer poll
 *
 * The spec drives one flow at a time (Playwright `workers: 1`), so a single
 * pending identity — consumed by the next authorize, keyed to the issued code —
 * is race-free.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// jose is a dependency of `apps/api`, not the repo root, so resolve it from
// there (matching the version the API verifies with) via a CJS require.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', '..', 'apps', 'api');
const jose = require(require.resolve('jose', { paths: [apiDir] }));
const { generateKeyPair, exportJWK, SignJWT } = jose;

const PORT = Number(process.env.E2E_FAKE_GOOGLE_PORT ?? 4545);
// The `aud` minted into every id_token — must equal the API's BT_GOOGLE_CLIENT_ID.
const CLIENT_ID = process.env.BT_GOOGLE_CLIENT_ID ?? 'e2e-google-client-id';
// The real Google issuer, so the API's unchanged issuer check passes.
const ISSUER = 'https://accounts.google.com';
// Where to bounce the browser back to — the WEB origin (proxied callback), so the
// host-only `bt_goog_state` cookie set at `/start` rides along. Falls back to the
// callback's own origin (the API `redirect_uri`) when unset.
const CALLBACK_ORIGIN = process.env.E2E_GOOGLE_CALLBACK_ORIGIN ?? '';
const KID = 'e2e-fake-google-key';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = KID;
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';
const jwksBody = JSON.stringify({ keys: [publicJwk] });

/** The identity the next `/authorize` will bind a code to (single, sequential). */
let pendingIdentity = null;
/** code → identity, so the token exchange mints exactly what authorize captured. */
const codesToIdentity = new Map();

/** Read a whole request body as a string. */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function mintIdToken(identity) {
  return new SignJWT({
    email: identity.email,
    email_verified: identity.email_verified !== false,
    ...(identity.name ? { name: identity.name } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(identity.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/jwks' || url.pathname === '/certs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jwksBody);
      return;
    }

    // Prime the identity the next authorize round-trip will sign in as.
    if (req.method === 'POST' && url.pathname === '/__identity') {
      const raw = await readBody(req);
      let identity;
      try {
        identity = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid_identity_json' });
        return;
      }
      if (!identity || typeof identity.sub !== 'string' || typeof identity.email !== 'string') {
        sendJson(res, 400, { error: 'identity_requires_sub_and_email' });
        return;
      }
      pendingIdentity = identity;
      sendJson(res, 200, { ok: true });
      return;
    }

    // Authorization endpoint: bounce straight back to the callback with a code.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      if (!redirectUri) {
        sendJson(res, 400, { error: 'missing_redirect_uri' });
        return;
      }
      if (!pendingIdentity) {
        sendJson(res, 400, { error: 'no_pending_identity' });
        return;
      }
      const code = `fake-code-${Math.abs(hashString(pendingIdentity.sub + state + redirectUri))}-${codesToIdentity.size}`;
      codesToIdentity.set(code, pendingIdentity);
      pendingIdentity = null;

      // Rewrite the callback onto the web origin so the host-only state cookie
      // rides back with this top-level navigation (see the file header).
      const callback = new URL(redirectUri);
      if (CALLBACK_ORIGIN) {
        const origin = new URL(CALLBACK_ORIGIN);
        callback.protocol = origin.protocol;
        callback.host = origin.host;
      }
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      res.writeHead(302, { location: callback.toString() });
      res.end();
      return;
    }

    // Token endpoint: exchange the code for a signed id_token.
    if (req.method === 'POST' && url.pathname === '/token') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const code = params.get('code') ?? '';
      const identity = codesToIdentity.get(code);
      if (!identity) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      codesToIdentity.delete(code);
      const idToken = await mintIdToken(identity);
      sendJson(res, 200, {
        access_token: 'fake-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken,
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    // Never crash the harness on a malformed request — surface a 500 and log.
    console.error('[fake-google-idp] request failed', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  }
});

/** Deterministic small hash so a code is stable per (sub, state, redirect) tuple. */
function hashString(input) {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return h;
}

server.listen(PORT, () => {
  console.log(`[fake-google-idp] listening on :${PORT} (aud=${CLIENT_ID})`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
