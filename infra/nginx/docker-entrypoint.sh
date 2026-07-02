#!/bin/sh
# BetterTrack web front-proxy entrypoint (PROJECTPLAN.md §4.6, §11).
#
# Selects the nginx server-block layout from BT_MODE (subdomains | ports),
# derives the public API origin exactly like apps/api/src/config/env.ts
# (deriveOrigins), and renders the chosen template with envsubst. The SAME built
# image boots in either mode from env alone — no rebuild, no per-origin config
# baked in (config.js is generated per server block, §7.1).
set -eu

MODE="${BT_MODE:-subdomains}"
DOMAIN="${BT_DOMAIN:-localhost}"

# TLS default per mode (subdomains → https, ports → http); BT_TLS forces it.
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

# Derived public API origin (explicit override wins), consumed by the injected
# per-origin config.js so the SPA calls the right cross-origin API.
if [ -n "${BT_API_ORIGIN:-}" ]; then
    API_ORIGIN="$BT_API_ORIGIN"
elif [ "$MODE" = "subdomains" ]; then
    API_ORIGIN="${SCHEME}://${BT_SUB_API:-api}.${DOMAIN}"
else
    API_ORIGIN="${SCHEME}://${DOMAIN}:${BT_PORT_API:-3000}"
fi
API_ORIGIN="${API_ORIGIN%/}"

export BT_DOMAIN="$DOMAIN"
export BT_SUB_API="${BT_SUB_API:-api}"
export BT_SUB_WEB="${BT_SUB_WEB:-web}"
export BT_SUB_ADMIN="${BT_SUB_ADMIN:-admin}"
export BT_PORT_API="${BT_PORT_API:-3000}"
export BT_PORT_WEB="${BT_PORT_WEB:-8080}"
export BT_PORT_ADMIN="${BT_PORT_ADMIN:-8081}"
export API_UPSTREAM="${API_UPSTREAM:-api:3000}"
export API_ORIGIN

TEMPLATE="/etc/nginx/bt-templates/${MODE}.conf.template"
if [ ! -f "$TEMPLATE" ]; then
    echo "bettertrack-web: unknown BT_MODE='${MODE}' (expected 'subdomains' or 'ports')" >&2
    exit 1
fi

# Restrict envsubst to OUR vars so nginx runtime vars ($host, $uri, …) survive.
VARS='${BT_DOMAIN} ${BT_SUB_API} ${BT_SUB_WEB} ${BT_SUB_ADMIN} ${BT_PORT_API} ${BT_PORT_WEB} ${BT_PORT_ADMIN} ${API_UPSTREAM} ${API_ORIGIN}'
envsubst "$VARS" < "$TEMPLATE" > /etc/nginx/conf.d/default.conf

echo "bettertrack-web: mode=${MODE} apiOrigin=${API_ORIGIN}"
exec nginx -g 'daemon off;'
