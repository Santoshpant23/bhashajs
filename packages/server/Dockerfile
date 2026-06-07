# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# npm install (not ci): this package's lockfile is maintained at the monorepo
# root, so a standalone `npm ci` here can't guarantee a synced per-package lock.
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 5000
# Container-level readiness: the orchestrator restarts the container if the app
# stops reporting healthy (the /api/health endpoint checks Mongo connectivity).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1
CMD ["node", "dist/index.js"]
