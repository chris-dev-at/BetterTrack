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
case "$API_ORIGIN" in
    https://*) WS_ORIGIN="wss://${API_ORIGIN#https://}" ;;
    http://*) WS_ORIGIN="ws://${API_ORIGIN#http://}" ;;
    *)
        echo "bettertrack-web: BT_API_ORIGIN must use http:// or https://" >&2
        exit 1
        ;;
esac

# ── frame-src origin for the admin Grafana embed (§13.5 V5-P2 arc (a)) ────────
# The Diagnostics panel embeds BT_GRAFANA_PUBLIC_URL verbatim when that
# auth-gated-subdomain path is configured (apps/api/src/config/env.ts:230 →
# monitoringService `externalUrl` → MonitoringPage), otherwise it embeds the
# admin proxy under ${API_ORIGIN}. The value is env-only — never admin-runtime
# settable — so it is fully knowable here and the CSP can cover exactly the
# configured origin instead of opening frame-src to the whole https web.
#
# Rendered as a SPACE-PREFIXED origin (" https://grafana.example.com") so the
# policy template concatenates it without leaving a stray separator when unset.
# Only the origin survives: BT_GRAFANA_PUBLIC_URL accepts any URL (a path like
# https://obs.example.com/grafana/ is valid) but CSP source expressions match on
# scheme/host/port. This string lands inside a header value, so anything that
# could terminate or extend the policy is a boot failure, not a sanitized value.
GRAFANA_FRAME_SRC=''
GRAFANA_PUBLIC_URL="$(printf '%s' "${BT_GRAFANA_PUBLIC_URL:-}" |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -n "$GRAFANA_PUBLIC_URL" ]; then
    # Reduce to scheme://host[:port] — drop path, query and fragment. URL schemes
    # are case-insensitive, so accept HTTPS:// like the api's zod url() does.
    GRAFANA_SCHEME="$(printf '%s' "${GRAFANA_PUBLIC_URL%%://*}" | tr '[:upper:]' '[:lower:]')"
    case "$GRAFANA_SCHEME" in
        http | https) ;;
        *)
            echo "bettertrack-web: BT_GRAFANA_PUBLIC_URL must use http:// or https:// ('${GRAFANA_PUBLIC_URL}')" >&2
            exit 1
            ;;
    esac
    GRAFANA_REST="${GRAFANA_PUBLIC_URL#*://}"
    GRAFANA_AUTHORITY="${GRAFANA_REST%%/*}"
    GRAFANA_AUTHORITY="${GRAFANA_AUTHORITY%%\?*}"
    GRAFANA_AUTHORITY="${GRAFANA_AUTHORITY%%#*}"
    # Whitelist the authority: a bare hostname/IPv4 (or the [..] IPv6 form) with
    # an optional :port. Rejects whitespace, quotes, ';', userinfo, '*' — every
    # shape that could corrupt or widen the rendered Content-Security-Policy.
    if ! printf '%s' "$GRAFANA_AUTHORITY" |
        grep -Eq '^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?$'; then
        echo "bettertrack-web: BT_GRAFANA_PUBLIC_URL host is not a bare host[:port] ('${GRAFANA_PUBLIC_URL}')" >&2
        exit 1
    fi
    GRAFANA_FRAME_SRC=" ${GRAFANA_SCHEME}://${GRAFANA_AUTHORITY}"
fi

export BT_DOMAIN="$DOMAIN"
export BT_SUB_API="${BT_SUB_API:-api}"
export BT_SUB_WEB="${BT_SUB_WEB:-web}"
export BT_SUB_ADMIN="${BT_SUB_ADMIN:-admin}"
export BT_SUB_MOBILE="${BT_SUB_MOBILE:-mobile}"
export BT_PORT_API="${BT_PORT_API:-3000}"
export BT_PORT_WEB="${BT_PORT_WEB:-8080}"
export BT_PORT_ADMIN="${BT_PORT_ADMIN:-8081}"
export BT_PORT_PRODUCT="${BT_PORT_PRODUCT:-8082}"
export BT_PORT_MOBILE="${BT_PORT_MOBILE:-8083}"
export API_UPSTREAM="${API_UPSTREAM:-api:3000}"
# Static product/mobile landing pages live in the separate `landing` container
# (§13.3 V3-P12). The apex origin serves its product page, `mobile.` serves the
# mobile placeholder — both proxied to this upstream over the internal network.
export LANDING_UPSTREAM="${LANDING_UPSTREAM:-landing:80}"
export API_ORIGIN WS_ORIGIN GRAFANA_FRAME_SRC

# The override keeps the shipped paths fixed while allowing the topology test to
# execute this exact entrypoint against an isolated temporary nginx tree (same
# pattern as BT_LANDING_HTML_ROOT in apps/landing/docker-entrypoint.sh).
NGINX_ROOT="${BT_NGINX_CONF_ROOT:-/etc/nginx}"

TEMPLATE="${NGINX_ROOT}/bt-templates/${MODE}.conf.template"
if [ ! -f "$TEMPLATE" ]; then
    echo "bettertrack-web: unknown BT_MODE='${MODE}' (expected 'subdomains' or 'ports')" >&2
    exit 1
fi

# Restrict envsubst to OUR vars so nginx runtime vars ($host, $uri, …) survive.
VARS='${BT_DOMAIN} ${BT_SUB_API} ${BT_SUB_WEB} ${BT_SUB_ADMIN} ${BT_SUB_MOBILE} ${BT_PORT_API} ${BT_PORT_WEB} ${BT_PORT_ADMIN} ${BT_PORT_PRODUCT} ${BT_PORT_MOBILE} ${API_UPSTREAM} ${LANDING_UPSTREAM} ${API_ORIGIN} ${WS_ORIGIN} ${GRAFANA_FRAME_SRC}'
INCLUDE_DIR="${NGINX_ROOT}/bt-includes"
mkdir -p "$INCLUDE_DIR"
envsubst "$VARS" \
    < "${NGINX_ROOT}/bt-templates/includes/static-security-headers.conf.template" \
    > "$INCLUDE_DIR/static-security-headers.conf"
if [ "$SCHEME" = "https" ]; then
    cp "${NGINX_ROOT}/bt-templates/includes/static-hsts.conf" "$INCLUDE_DIR/static-hsts.conf"
else
    # Keep the include valid but empty for every plain-HTTP layout.
    : > "$INCLUDE_DIR/static-hsts.conf"
fi
envsubst "$VARS" < "$TEMPLATE" > "${NGINX_ROOT}/conf.d/default.conf"

echo "bettertrack-web: mode=${MODE} apiOrigin=${API_ORIGIN}"
exec nginx -g 'daemon off;'
