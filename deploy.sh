#!/bin/bash
# ─────────────────────────────────────────────────────────────
# BhashaJS — First-time deployment script
# Run this on your VM after cloning the repo.
# ─────────────────────────────────────────────────────────────
set -e

DOMAIN="bhashajs.tech"
EMAIL="${1:?Usage: ./deploy.sh your-email@example.com}"

echo "=== BhashaJS Deployment ==="
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"
echo ""

# ── Step 1: Check .env exists ────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found!"
  echo "Copy .env.example to .env and fill in your secrets first."
  echo "  cp .env.example .env"
  echo "  nano .env"
  exit 1
fi

# ── Step 2: Use init config (HTTP-only) for cert bootstrap ───
echo ">>> Step 1/4: Starting with HTTP-only config for SSL bootstrap..."
docker exec bhashajs-dashboard-1 sh -c \
  "cp /etc/nginx/nginx.init.conf /etc/nginx/conf.d/default.conf && nginx -s reload" 2>/dev/null \
  || true

# Build and start all services
docker compose up -d --build

echo ">>> Waiting for services to start..."
sleep 5

# ── Step 3: Swap to init config inside running container ─────
echo ">>> Step 2/4: Switching nginx to init config..."
docker compose exec dashboard sh -c \
  "cp /etc/nginx/nginx.init.conf /etc/nginx/conf.d/default.conf && nginx -s reload"

sleep 2

# ── Step 4: Get SSL certificate ─────────────────────────────
echo ">>> Step 3/4: Requesting SSL certificate from Let's Encrypt..."
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  -d "www.$DOMAIN"

# ── Step 5: Switch to full SSL config ────────────────────────
echo ">>> Step 4/4: Enabling HTTPS..."
docker compose exec dashboard sh -c \
  "cp /etc/nginx/nginx.init.conf /etc/nginx/conf.d/default.conf.bak 2>/dev/null; true"

# The Dockerfile already copies nginx.conf (with SSL) as default.conf,
# but we overrode it in step 2. Now rebuild to get the SSL config back.
docker compose up -d --build dashboard

echo ""
echo "=== Deployment complete! ==="
echo "  https://$DOMAIN"
echo ""
echo "To renew certs (run monthly via cron):"
echo "  docker compose run --rm certbot renew && docker compose exec dashboard nginx -s reload"
