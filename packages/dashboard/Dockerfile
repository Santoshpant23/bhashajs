# Stage 1: Build the static SPA from the MONOREPO ROOT context.
#
# IMPORTANT: the build context is the repo root (see docker-compose.yml), NOT
# packages/dashboard. Building from the root lets the npm workspace link the
# dashboard's `bhasha-js` dependency to the LOCAL packages/sdk, so the self-host
# build never reaches the public npm registry (which can lag the in-repo SDK
# version and would otherwise fail with ETARGET until the new SDK is published).
FROM node:20-alpine AS builder
WORKDIR /app

# Copy only the manifests first so `npm install` is cached across source edits.
# The root lock plus the two workspace package.jsons are all npm needs to plan
# the install and wire `bhasha-js` -> packages/sdk via the workspace symlink.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json

# Install the whole workspace. `bhasha-js` resolves to the local packages/sdk
# (no registry fetch), satisfying the dashboard's `^0.4.0` range from source.
RUN npm install

# Now bring in the sources for the two workspaces we actually build.
COPY packages/sdk ./packages/sdk
COPY packages/dashboard ./packages/dashboard

# Build the SDK first — the dashboard imports `bhasha-js` at build time, so its
# dist must exist before Vite/tsc resolves the import.
RUN npm run build --workspace bhasha-js

# Then build the dashboard SPA. Output lands at packages/dashboard/dist.
RUN npm run build --workspace bhashajs-dashboard

# Stage 2: Serve with Caddy (AUTOMATIC HTTPS — no certbot, no cert dance).
# Caddy provisions a Let's Encrypt cert for a real $DOMAIN on first boot, or a
# locally-trusted cert for `localhost`. The SPA ships at /srv; the Caddyfile
# (in this package) handles the SPA fallback + /api proxy to the server container.
FROM caddy:alpine AS runner
COPY --from=builder /app/packages/dashboard/dist /srv
COPY packages/dashboard/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
