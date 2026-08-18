#!/bin/sh
# BetterTrack web front-proxy entrypoint (PROJECTPLAN.md §4.6, §11).
#
# Selects the nginx server-block layout from BT_MODE (subdomains | ports),
# derives the public API and product origins exactly like
# apps/api/src/config/env.ts (deriveOrigins), and renders the chosen template
# with envsubst. The SAME built image boots in either mode from env alone — no
# rebuild, no per-origin config baked in (config.js is generated per server
# block, §7.1).
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

# ── Browser-facing origin validation (reject, don't scrub) ───────────────────
# API_ORIGIN, WS_ORIGIN and PRODUCT_ORIGIN are interpolated into two contexts
# where one stray byte is a vulnerability rather than a typo:
#
#   • the per-origin config.js, rendered from
#     `return 200 'window.__BT__ = { …, apiOrigin: "${API_ORIGIN}", … };';`
#     The nginx string literal is SINGLE-quoted, so an embedded `"` never breaks
#     the nginx config — it breaks out of the JavaScript string and executes on
#     every user AND admin page.
#   • the Content-Security-Policy header, where a stray space or `;` widens the
#     policy for the whole app.
#
# The API's env contract is NOT a gate for this: BT_API_ORIGIN and
# BT_PRODUCT_ORIGIN are `optionalUrl` (apps/api/src/config/env.ts), i.e. a zod
# `.url()`, which only asserts `new URL()` parses and hands back the ORIGINAL
# string — `https://p.example/" }; globalThis.x = 1; //` is a well-formed URL.
# So the shell → JavaScript boundary is validated here, with the same policy the
# Grafana frame-src below already applies: whitelist a bare host[:port]
# authority and FAIL THE BOOT with a diagnostic instead of silently sanitizing a
# value the operator believes is configured. Validating the DERIVED origin (not
# just the override) means a poisoned BT_DOMAIN also stops the boot before
# anything is rendered.
#
# One authority whitelist for every browser-facing origin this script renders:
# a hostname/IPv4, or the bracketed IPv6 form, with an optional port. It rejects
# whitespace, control characters, quotes, `;`, `}`, backslashes, `*`, userinfo
# (`user:pass@host`) and any path, query or fragment.
BARE_AUTHORITY_PATTERN='^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?$'

# Compose materializes an unset `${VAR:-}` as an empty string, and the api's env
# schema coerces a whitespace-only value to "unset" as well (optionalUrl). Mirror
# that here so a blank override derives the origin instead of failing the boot.
is_configured() {
    [ -n "$(printf '%s' "$1" | sed 's/[[:space:]]//g')" ]
}

# Echo `scheme://authority` for a bare origin, or fail with a diagnostic naming
# the variable the value came from.
#   $1 accepted schemes (space separated)   $2 variable name   $3 candidate
validated_origin() {
    origin_schemes="$1"
    origin_name="$2"
    # Diagnostics quote the value as configured; validation sees it with the one
    # optional trailing slash removed (`https://host/` is a bare origin).
    origin_raw="$3"
    origin_value="${3%/}"

    # A newline would let a hostile tail hide on a second line, where the
    # line-oriented grep below would never look.
    if [ "$origin_value" != "$(printf '%s' "$origin_value" | tr -d '\r\n')" ]; then
        echo "bettertrack-web: ${origin_name} must be a single-line origin" >&2
        return 1
    fi

    # URL schemes are case-insensitive, so HTTPS:// is accepted exactly like the
    # api's zod url() accepts it — but normalized before anything consumes it.
    origin_scheme="$(printf '%s' "${origin_value%%://*}" | tr '[:upper:]' '[:lower:]')"
    case " ${origin_schemes} " in
        *" ${origin_scheme} "*) ;;
        *)
            echo "bettertrack-web: ${origin_name} must use one of: ${origin_schemes} ('${origin_raw}')" >&2
            return 1
            ;;
    esac

    # Hostnames are case-insensitive too; normalizing them keeps this rendering
    # byte-identical to the landing container's, whose Node entrypoint emits
    # `new URL(...).origin` for the very same override.
    origin_authority="$(printf '%s' "${origin_value#*://}" | tr '[:upper:]' '[:lower:]')"
    if ! printf '%s' "$origin_authority" | grep -Eq "$BARE_AUTHORITY_PATTERN"; then
        echo "bettertrack-web: ${origin_name} must be a bare ${origin_scheme}://host[:port] origin ('${origin_raw}')" >&2
        return 1
    fi

    printf '%s://%s' "$origin_scheme" "$origin_authority"
}

# Derived public API origin (explicit override wins), consumed by the injected
# per-origin config.js so the SPA calls the right cross-origin API.
API_ORIGIN_NAME='BT_API_ORIGIN'
if is_configured "${BT_API_ORIGIN:-}"; then
    API_ORIGIN="$BT_API_ORIGIN"
else
    API_ORIGIN_NAME='the API origin derived from BT_DOMAIN'
    if [ "$MODE" = "subdomains" ]; then
        API_ORIGIN="${SCHEME}://${BT_SUB_API:-api}.${DOMAIN}"
    else
        API_ORIGIN="${SCHEME}://${DOMAIN}:${BT_PORT_API:-3000}"
    fi
fi
API_ORIGIN="$(validated_origin 'http https' "$API_ORIGIN_NAME" "$API_ORIGIN")" || exit 1

# The WebSocket source is the API origin under the matching ws scheme. It is
# built from the ALREADY-validated authority and re-checked through the same
# gate, so connect-src can never carry a byte config.js would have rejected.
case "${API_ORIGIN%%://*}" in
    https) WS_ORIGIN="wss://${API_ORIGIN#*://}" ;;
    *) WS_ORIGIN="ws://${API_ORIGIN#*://}" ;;
esac
WS_ORIGIN="$(validated_origin 'ws wss' 'the WebSocket origin derived from the API origin' "$WS_ORIGIN")" || exit 1

# Derived product-site origin (explicit override wins), consumed by the SPA's
# legal-link helper. It follows the same topology as the landing proxy: apex in
# subdomains mode, dedicated product port in ports mode.
PRODUCT_ORIGIN_NAME='BT_PRODUCT_ORIGIN'
if is_configured "${BT_PRODUCT_ORIGIN:-}"; then
    PRODUCT_ORIGIN="$BT_PRODUCT_ORIGIN"
else
    PRODUCT_ORIGIN_NAME='the product origin derived from BT_DOMAIN'
    if [ "$MODE" = "subdomains" ]; then
        PRODUCT_ORIGIN="${SCHEME}://${DOMAIN}"
    else
        PRODUCT_ORIGIN="${SCHEME}://${DOMAIN}:${BT_PORT_PRODUCT:-8082}"
    fi
fi
PRODUCT_ORIGIN="$(validated_origin 'http https' "$PRODUCT_ORIGIN_NAME" "$PRODUCT_ORIGIN")" || exit 1

# Public Google Cloud SPA OAuth client id rendered into config.js. The value is
# not a secret, but it still crosses a shell → JavaScript boundary: accept only
# the character set used by Google client ids so configuration can never inject
# JavaScript into the user or admin origin. Blank deliberately disables Drive.
BT_GOOGLE_DRIVE_CLIENT_ID="${BT_GOOGLE_DRIVE_CLIENT_ID:-}"
case "$BT_GOOGLE_DRIVE_CLIENT_ID" in
    '') ;;
    *[!A-Za-z0-9._-]*)
        echo "bettertrack-web: BT_GOOGLE_DRIVE_CLIENT_ID must be a Google Cloud SPA OAuth client id" >&2
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
GRAFANA_PUBLIC_URL_RAW="${BT_GRAFANA_PUBLIC_URL:-}"
GRAFANA_PUBLIC_URL_SINGLE_LINE="$(printf '%s' "$GRAFANA_PUBLIC_URL_RAW" | tr -d '\r\n')"
if [ "$GRAFANA_PUBLIC_URL_RAW" != "$GRAFANA_PUBLIC_URL_SINGLE_LINE" ]; then
    echo "bettertrack-web: BT_GRAFANA_PUBLIC_URL must be a single-line URL" >&2
    exit 1
fi
GRAFANA_PUBLIC_URL="$(printf '%s' "$GRAFANA_PUBLIC_URL_RAW" |
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
    # Whitelist the authority with the SAME pattern the browser-facing origins
    # above use — one policy for every value that reaches a header or config.js.
    # Rejects whitespace, quotes, ';', userinfo, '*' — every shape that could
    # corrupt or widen the rendered Content-Security-Policy.
    if ! printf '%s' "$GRAFANA_AUTHORITY" | grep -Eq "$BARE_AUTHORITY_PATTERN"; then
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
export API_ORIGIN PRODUCT_ORIGIN WS_ORIGIN GRAFANA_FRAME_SRC BT_GOOGLE_DRIVE_CLIENT_ID

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
VARS='${BT_DOMAIN} ${BT_SUB_API} ${BT_SUB_WEB} ${BT_SUB_ADMIN} ${BT_SUB_MOBILE} ${BT_PORT_API} ${BT_PORT_WEB} ${BT_PORT_ADMIN} ${BT_PORT_PRODUCT} ${BT_PORT_MOBILE} ${BT_GOOGLE_DRIVE_CLIENT_ID} ${API_UPSTREAM} ${LANDING_UPSTREAM} ${API_ORIGIN} ${PRODUCT_ORIGIN} ${WS_ORIGIN} ${GRAFANA_FRAME_SRC}'
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

echo "bettertrack-web: mode=${MODE} apiOrigin=${API_ORIGIN} productOrigin=${PRODUCT_ORIGIN}"
exec nginx -g 'daemon off;'
