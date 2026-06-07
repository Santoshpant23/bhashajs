#!/bin/bash
# ─────────────────────────────────────────────────────────────
# BhashaJS — first-time SELF-HOST deployment (bundled Mongo + nginx + certbot).
#
# NOTE: the hosted production (the GCP VM) does NOT use this script. Production
# runs ONLY the server container via `docker-compose.prod.yml` behind Caddy
# (auto-HTTPS) against MongoDB Atlas + Vertex AI. This script is the self-host
# path defined by `docker-compose.yml`.
#
# Usage:  [DOMAIN=example.com] ./deploy.sh your-email@example.com
#         (DOMAIN defaults to bhashajs.com)
#
# Self-hosting a non-default domain? Also set `server_name` (and the cert paths)
# in packages/dashboard/nginx.conf to match $DOMAIN before running.
# ─────────────────────────────────────────────────────────────
set -e

DOMAIN="${DOMAIN:-bhashajs.com}"
EMAIL="${1:?Usage: [DOMAIN=example.com] ./deploy.sh your-email@example.com}"

echo "=== BhashaJS self-host deploy ==="
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"
echo ""

# ── Pre-flight: .env must exist ──────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found!"
  echo "Copy .env.example to .env and fill in your secrets first:"
  echo "  cp .env.example .env && nano .env"
  exit 1
fi

# ── Step 1: Build + start (nginx boots HTTP-only) ────────────
# The dashboard image now ships the HTTP-only config as default, so nginx starts
# cleanly without certs and serves the ACME challenge — no more crash-loop.
echo ">>> Step 1/3: Building and starting services (HTTP-only nginx)..."
docker compose up -d --build

echo ">>> Waiting for nginx to accept connections..."
sleep 5

# ── Step 2: Obtain the certificate over HTTP ─────────────────
# --entrypoint certbot overrides the service's renew-loop entrypoint so this
# one-off `certonly` actually runs (otherwise the args are swallowed by the loop).
echo ">>> Step 2/3: Requesting SSL certificate from Let's Encrypt..."
docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  -d "www.$DOMAIN"

# ── Step 3: Swap nginx to the SSL config and reload ──────────
echo ">>> Step 3/3: Enabling HTTPS..."
docker compose exec dashboard sh -c \
  "cp /etc/nginx/nginx.ssl.conf /etc/nginx/conf.d/default.conf && nginx -t && nginx -s reload"

echo ""
echo "=== Deployment complete! ==="
echo "  https://$DOMAIN"
echo ""
echo "Renew certs monthly (cron):"
echo "  docker compose run --rm certbot renew && \\"
echo "    docker compose exec dashboard sh -c 'nginx -s reload'"
