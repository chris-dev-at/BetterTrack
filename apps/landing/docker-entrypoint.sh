#!/bin/sh
# BetterTrack landing site — origin injection (V3-P12).
#
# Runs inside nginx:alpine's /docker-entrypoint.d/ hook before nginx starts.
# Renders env.js from its template so links and the registration-mode probe use
# the same public topology as the front proxy without rebuilding the image.
# The Node runtime installed in the image validates the origins with URL and
# JSON-encodes the browser config, rather than interpolating env into JavaScript.
set -eu

MODE="${BT_MODE:-subdomains}"
DOMAIN="${BT_DOMAIN:-localhost}"

# Keep scheme selection byte-for-byte aligned with the web front proxy:
# subdomains default to HTTPS, ports to HTTP, and BT_TLS overrides either.
if [ -n "${BT_TLS:-}" ]; then
  TLS_RAW="$BT_TLS"
elif [ "$MODE" = "subdomains" ]; then
  TLS_RAW="true"
else
  TLS_RAW="false"
fi
case "$(printf '%s' "$TLS_RAW" | tr '[:upper:]' '[:lower:]')" in
  true | 1 | yes | on) SCHEME="https" ;;
  *) SCHEME="http" ;;
esac

case "$MODE" in
  subdomains | ports) ;;
  *)
    echo "bettertrack-landing: unknown BT_MODE='${MODE}' (expected 'subdomains' or 'ports')" >&2
    exit 1
    ;;
esac

# Explicit overrides win exactly as they do in the API and front proxy.
if [ -n "${BT_WEB_ORIGIN:-}" ]; then
  WEB_ORIGIN="$BT_WEB_ORIGIN"
elif [ "$MODE" = "subdomains" ]; then
  WEB_ORIGIN="${SCHEME}://${BT_SUB_WEB:-web}.${DOMAIN}"
else
  WEB_ORIGIN="${SCHEME}://${DOMAIN}:${BT_PORT_WEB:-8080}"
fi

if [ -n "${BT_API_ORIGIN:-}" ]; then
  API_ORIGIN="$BT_API_ORIGIN"
elif [ "$MODE" = "subdomains" ]; then
  API_ORIGIN="${SCHEME}://${BT_SUB_API:-api}.${DOMAIN}"
else
  API_ORIGIN="${SCHEME}://${DOMAIN}:${BT_PORT_API:-3000}"
fi

BT_WEB_ORIGIN="${WEB_ORIGIN%/}"
BT_API_ORIGIN="${API_ORIGIN%/}"
export BT_WEB_ORIGIN BT_API_ORIGIN

# The override keeps the shipped path fixed while allowing the topology test to
# execute this exact entrypoint against an isolated temporary template.
HTML_ROOT="${BT_LANDING_HTML_ROOT:-/usr/share/nginx/html}"
node - "$HTML_ROOT/env.js.template" "$HTML_ROOT/env.js" <<'NODE'
const fs = require('node:fs');

const [templatePath, outputPath] = process.argv.slice(2);
const controlCharacter = /[\u0000-\u001F\u007F]/;

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function validatedOrigin(name) {
  const raw = process.env[name];
  if (!raw || raw.trim() !== raw || controlCharacter.test(raw)) {
    throw new Error(`${name} must be a valid public origin`);
  }

  let origin;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid public origin`);
  }

  const allowedProtocol =
    origin.protocol === 'https:' || (origin.protocol === 'http:' && isLoopback(origin.hostname));
  const isBareOrigin =
    !origin.username &&
    !origin.password &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash;
  if (!allowedProtocol || !isBareOrigin) {
    throw new Error(`${name} must be an https: origin or an http: loopback origin`);
  }

  return origin.origin;
}

try {
  const template = fs.readFileSync(templatePath, 'utf8');
  const marker = '__BT_LANDING_CONFIG__';
  if (template.split(marker).length !== 2) {
    throw new Error('env.js.template must contain exactly one config marker');
  }

  const config = JSON.stringify({
    webOrigin: validatedOrigin('BT_WEB_ORIGIN'),
    apiOrigin: validatedOrigin('BT_API_ORIGIN'),
  });
  fs.writeFileSync(outputPath, template.replace(marker, config), 'utf8');
} catch (error) {
  const message = error instanceof Error ? error.message : 'could not render runtime config';
  console.error(`bettertrack-landing: ${message}`);
  process.exitCode = 1;
}
NODE
