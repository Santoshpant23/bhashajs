# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# npm install (not ci): the dashboard has no standalone lockfile (the monorepo
# lock lives at the root), so `npm ci` would abort. This is the self-host build;
# the hosted dashboard is built by Vercel from the workspace root.
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
# Boot with the HTTP-only config so nginx starts WITHOUT certs and can serve the
# ACME webroot challenge on first deploy (the old default shipped the SSL config,
# which referenced certs that don't exist yet → crash-loop). deploy.sh swaps in
# the SSL config (nginx.ssl.conf) once Let's Encrypt has issued the certificate.
COPY nginx.init.conf /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.ssl.conf
EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
