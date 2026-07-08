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

envsubst '${BT_WEB_ORIGIN}' \
  < /usr/share/nginx/html/env.js.template \
  > /usr/share/nginx/html/env.js
