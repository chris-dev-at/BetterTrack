# BetterTrack product landing + mobile placeholder (V3-P12, arcs a+b).
#
# A pure static site — no SPA framework, no build step, no API dependency. Served
# straight from nginx:alpine. The only start-time work is rendering env.js from
# its template so web/API origins follow the deployed topology (env, not baked in).
#
# Build from the repo root so the compose `context: ..` resolves this path:
#   docker build -f apps/landing/Dockerfile -t bettertrack-landing .
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS runner

# Static site content → nginx web root. The canonical legal directories under
# site/ are copied with the landing pages, so nginx resolves /<page>/ and
# /<page>/de/ through each directory's index.html.
COPY apps/landing/site/ /usr/share/nginx/html/

# The shared legal chrome links the bespoke live site's product pages. Keep
# those routes non-broken in generic images by serving the one-page landing
# content there too, including its full feature section.
RUN for route in features security roadmap; do \
      mkdir -p "/usr/share/nginx/html/${route}" && \
      cp /usr/share/nginx/html/index.html "/usr/share/nginx/html/${route}/index.html"; \
    done

# Origin-injection hook: nginx:alpine runs /docker-entrypoint.d/*.sh before start.
COPY apps/landing/docker-entrypoint.sh /docker-entrypoint.d/40-bt-landing-env.sh
RUN apk add --no-cache nodejs && chmod +x /docker-entrypoint.d/40-bt-landing-env.sh

EXPOSE 80
