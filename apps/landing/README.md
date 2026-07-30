# BetterTrack landing site

The public **bettertrack.at** product landing page and the **mobile.bettertrack.at**
placeholder, shipped as their own tiny static site (PROJECTPLAN §13.3 · V3-P12,
arcs a + b). Separate from the SPA on purpose: no React, no Vite, no build step,
no API dependency — just HTML, one stylesheet and inline SVG screenshots, so the
pages render instantly.

## Pages (`site/`)

| File             | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `index.html`     | Product landing — English                   |
| `de.html`        | Product landing — German                    |
| `mobile.html`    | Mobile placeholder — English                |
| `mobile.de.html` | Mobile placeholder — German                 |
| `styles.css`     | Shared styles (app dark aesthetic)          |
| `landing.js`     | CSP-safe runtime link + registration wiring |
| `screens/*.svg`  | Feature screenshots                         |
| `env.js`         | Runtime origin config (regenerated at boot) |

Language is a visible EN/DE switch that links between the sibling files — the
SPA's runtime i18n layer does not apply to this separate static site. A human DE
pass is part of V3-P13.

> **Screenshots.** The `screens/*.svg` assets are faithful, framework-free
> reproductions of the real app surfaces (portfolio, Conglomerate builder,
> backtest, asset search) using the app's exact dark palette and wordmark. They
> carry no external dependencies, so the pages stay instant. Swapping in raster
> captures from the seeded stack (which needs Docker) is a drop-in replacement.

## Runtime origins

The "Open the web app" links resolve at runtime from `window.__BT_LANDING__.webOrigin`,
and the registration-mode probe reads `window.__BT_LANDING__.apiOrigin`. In the
container, `env.js` is regenerated from `env.js.template` by
`docker-entrypoint.sh` (an nginx `/docker-entrypoint.d` hook). The Compose service
passes the same mode, domain, TLS, subdomain, port, and explicit-origin inputs as
the front proxy, so links, fetches, and the CSP always agree without a rebuild.
The committed `env.js` is the local default.

## Serving it

Built and served by the `landing` service in `infra/docker-compose.yml`
(`apps/landing/Dockerfile`, nginx:alpine). Host-port publishing lives in the mode
overlays: the `web` front proxy exposes the product port (default `8082`) in ports
mode and reaches the landing container internally in both modes. The 5-origin
topology wiring (nginx templates, Cloudflare, deploy guide) is V3-P12 arc (c).

Preview locally without Docker by opening `site/index.html` in a browser, or:

```
cd apps/landing/site && python3 -m http.server 8082
```
