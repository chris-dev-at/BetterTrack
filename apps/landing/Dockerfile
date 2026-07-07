# BetterTrack product landing + mobile placeholder (V3-P12, arcs a+b).
#
# A pure static site — no SPA framework, no build step, no API dependency. Served
# straight from nginx:alpine. The only start-time work is rendering env.js from
# its template so the web-app links follow the deployed origin (env, not baked in).
#
# Build from the repo root so the compose `context: ..` resolves this path:
#   docker build -f apps/landing/Dockerfile -t bettertrack-landing .
FROM nginx:alpine AS runner

# Static site content → nginx web root.
COPY apps/landing/site/ /usr/share/nginx/html/

# Origin-injection hook: nginx:alpine runs /docker-entrypoint.d/*.sh before start.
COPY apps/landing/docker-entrypoint.sh /docker-entrypoint.d/40-bt-landing-env.sh
RUN chmod +x /docker-entrypoint.d/40-bt-landing-env.sh

EXPOSE 80
