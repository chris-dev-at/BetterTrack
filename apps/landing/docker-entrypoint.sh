#!/bin/sh
# BetterTrack landing site — origin injection (V3-P12).
#
# Runs inside nginx:alpine's /docker-entrypoint.d/ hook before nginx starts.
# Renders env.js from its template so the "Open the web app" links point at the
# deployed web origin without rebuilding the image. Mirrors the SPA's config.js
# pattern (§7.1). The full 5-origin topology derivation is arc (c) of V3-P12.
set -eu

: "${BT_WEB_ORIGIN:=https://web.bettertrack.at}"
export BT_WEB_ORIGIN
# The landing reads the active registration mode from the API to reflect it
# (§13.4 V4-P4a) — inject the API origin alongside the web origin.
: "${BT_API_ORIGIN:=https://api.bettertrack.at}"
export BT_API_ORIGIN

envsubst '${BT_WEB_ORIGIN} ${BT_API_ORIGIN}' \
  < /usr/share/nginx/html/env.js.template \
  > /usr/share/nginx/html/env.js
