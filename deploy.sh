#!/bin/bash
# ─────────────────────────────────────────────────────────────
# BhashaJS — one-command SELF-HOST deployment (bundled Mongo + Caddy auto-HTTPS).
#
# Truly one command: Caddy provisions and renews TLS automatically (Let's Encrypt
# for a real domain, a locally-trusted cert for `localhost`). No certbot, no cert
# paths, no nginx config swap — just bring the stack up.
#
# NOTE: the hosted production (the GCP VM) does NOT use this script. Production
# runs ONLY the server container via `docker-compose.prod.yml` behind Caddy on
# the HOST, against MongoDB Atlas + Vertex AI. This script is the self-host path
# defined by `docker-compose.yml`.
#
# Usage:  ./deploy.sh
#         Set DOMAIN in .env (e.g. DOMAIN=app.example.com) for a real domain with
#         automatic HTTPS. Leave it unset to serve on localhost for local testing.
# ─────────────────────────────────────────────────────────────
set -e

echo "=== BhashaJS self-host deploy ==="

# ── Pre-flight: .env must exist ──────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found!"
  echo "Copy .env.example to .env and fill in your secrets first:"
  echo "  cp .env.example .env && nano .env"
  exit 1
fi

# Surface the domain Caddy will serve (mirrors the compose default).
DOMAIN="$(grep -E '^DOMAIN=' .env | tail -n1 | cut -d= -f2- || true)"
echo "Domain: ${DOMAIN:-localhost (set DOMAIN in .env for a public domain)}"
echo ""

# ── Build + start. Caddy handles TLS on its own. ─────────────
echo ">>> Building and starting services..."
docker compose up -d --build

echo ""
echo "=== Deployment complete! ==="
if [ -n "$DOMAIN" ]; then
  echo "  https://$DOMAIN"
  echo ""
  echo "Caddy is provisioning a Let's Encrypt certificate now — give it a few"
  echo "seconds on first boot (DNS must already point at this server)."
else
  echo "  https://localhost  (locally-trusted Caddy cert)"
  echo ""
  echo "Set DOMAIN in .env and re-run ./deploy.sh to serve a public domain with"
  echo "automatic Let's Encrypt HTTPS."
fi
