# Local AI runbook — Ollama (V5-P12)

BetterTrack's AI features (portfolio insights, the natural-language conglomerate
builder — shipping in issue 2/2) run against **one provider only: a local
[Ollama](https://ollama.com) server on your own hardware**. There is no cloud
provider, no API key, and no per-call billing anywhere in the product (owner
decision 2026-07-22, PROJECTPLAN.md §16). If Ollama is not configured, the AI
features are simply invisible — nothing else changes.

This is the whole setup: install Ollama, pull one model, point BetterTrack at it.

## 1. Install Ollama on the LAN box

The owner's box is an RTX 4080 Super (16 GB VRAM), but the guidance below keeps a
future **8 GB-VRAM** host viable too.

```sh
# Linux (see ollama.com/download for macOS / Windows)
curl -fsSL https://ollama.com/install.sh | sh

# Ollama listens on 127.0.0.1:11434 by default. To reach it from the BetterTrack
# host over the LAN, bind it to all interfaces (systemd example):
#   sudo systemctl edit ollama
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
#   sudo systemctl restart ollama
```

Keep the endpoint on a trusted LAN — Ollama has no auth of its own.

## 2. Pull a model

Pick a **mid-size instruct model (~7–14B), quantized** — big enough to be useful,
small enough not to max the card (and to leave headroom on an 8 GB host):

```sh
# Recommended default — ~4.7 GB, comfortable on 8 GB VRAM:
ollama pull llama3.1:8b

# Also fine on 16 GB (do NOT max the card):
#   ollama pull qwen2.5:14b-instruct-q4_K_M
#   ollama pull mistral-nemo:12b-instruct-2407-q4_K_M
```

Rule of thumb: a `q4` quant of a 7–8B model needs ~5–6 GB VRAM; a 12–14B `q4`
needs ~9–11 GB. Stay a comfortable margin under the card so other work (and a
future smaller host) keeps running.

Verify the model answers:

```sh
ollama run llama3.1:8b "Say hello in one short sentence."
```

## 3. Point BetterTrack at it

Two equivalent ways — the admin UI is the easy one, env is the deploy default.

**Admin UI (no redeploy).** Admin → **AI**:

1. **Ollama endpoint** — e.g. `http://ollama.lan:11434` (or `http://localhost:11434`
   if Ollama runs on the BetterTrack host).
2. Click **Test connection** — this lists the models the endpoint serves; pick one.
3. **Model** — e.g. `llama3.1:8b`.
4. **Daily limit per user** — how many AI requests each user may make per UTC day.
5. **Save**. The change is live on the very next request (the provider config is
   resolved per request — no restart).

**Environment (deploy default).** Set these on the `api` (and `worker`) service;
the admin UI overrides them at runtime when set:

| Variable             | Meaning                                   | Example                   |
| -------------------- | ----------------------------------------- | ------------------------- |
| `BT_OLLAMA_ENDPOINT` | Ollama base URL                           | `http://ollama.lan:11434` |
| `BT_OLLAMA_MODEL`    | Default model name                        | `llama3.1:8b`             |
| `BT_AI_DAILY_CAP`    | Per-user daily request cap (default `20`) | `20`                      |

All three are **optional**. Unset (and with no admin override) ⇒ AI stays
disabled and the capability endpoint reports `available: false`. None of them is
a secret — the endpoint is a plain URL, never a token.

## 4. Confirm it's on

Admin → **AI** shows **Configured** once an endpoint _and_ a model resolve. The
user-facing capability endpoint (`GET /api/v1/ai/capability`) then reports
`available: true` with the per-user daily budget. The `ai` runtime feature flag
(Admin → Feature flags) is an independent kill-switch — with it off, AI hides
even while configured.

## Notes

- **Local only.** The app never reaches any host but the endpoint you configure.
- **No secrets stored.** Endpoint + model + cap are plain settings in the app's
  `app_settings` store; there is no token vault because there is no cloud provider.
- **Per-user daily cap** is a Redis counter keyed by user + UTC day; it resets at
  UTC midnight. Exhausting it returns a typed `AI_CAP_EXCEEDED` (HTTP 429).
