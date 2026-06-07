# Stage 1: Build the static SPA
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# npm install (not ci): the dashboard has no standalone lockfile (the monorepo
# lock lives at the root), so `npm ci` would abort. This is the self-host build;
# the hosted dashboard is built by Vercel from the workspace root.
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve with Caddy (AUTOMATIC HTTPS — no certbot, no cert dance).
# Caddy provisions a Let's Encrypt cert for a real $DOMAIN on first boot, or a
# locally-trusted cert for `localhost`. The SPA ships at /srv; the Caddyfile
# (in this package) handles the SPA fallback + /api proxy to the server container.
FROM caddy:alpine AS runner
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
