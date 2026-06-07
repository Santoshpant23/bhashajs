# Deployment guide — bhashajs.com

Step-by-step for going live tonight. Three things deploy independently:

1. **Marketing site** → `bhashajs.com` (Vercel)
2. **Dashboard** → `app.bhashajs.com` (Vercel)
3. **Backend API** → `api.bhashajs.com` (GCP VM + Caddy + Vertex AI)

Plus your existing **MongoDB Atlas** stays where it is.

---

## 0. Before anything: publish `bhasha-js@0.3.0` to npm

```bash
cd packages/sdk

# Log in if you aren't already
npm login

# Publish — prepublishOnly runs the build automatically
npm publish
```

Verify:
```bash
npm view bhasha-js version
# Should show 0.3.0
```

---

## 1. DNS at Namecheap (5 min, do this first so it's propagating)

Log in to Namecheap → Domain List → bhashajs.com → Manage → Advanced DNS.

Add these records:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| CNAME | `@` | `cname.vercel-dns.com` | Automatic |
| CNAME | `www` | `cname.vercel-dns.com` | Automatic |
| CNAME | `app` | `cname.vercel-dns.com` | Automatic |
| CNAME | `api` | (Railway will give you this) | Automatic |

> Note: Namecheap can have trouble with `CNAME @` — if it complains, use Vercel's IP address `76.76.21.21` as an `A` record for `@` and `www` instead.

DNS takes 5–60 minutes to propagate. While that happens, do the deploys below.

---

## 2. Backend on a GCP VM (`api.bhashajs.com`) behind Caddy — Vertex AI

The backend runs as a Docker container on a GCP VM, reverse-proxied by **Caddy**
(automatic HTTPS). AI translation uses **Vertex AI** (service-account auth,
billed to the GCP project's credit) instead of a free-tier API key. One VM can
host several apps — Caddy virtual-hosts them by domain — and MongoDB stays on
Atlas, so moving hosts needs no data migration.

### DNS
Point an `A` record for `api.bhashajs.com` at the VM's public IP.

### Layout on the VM (`~/bhashajs/`)
The Docker build context is `packages/server` (self-contained). Copy it up
(minus `node_modules`/`dist`) and add the secrets:
```
~/bhashajs/
  server/                 # contents of packages/server
  credentials/sa.json     # Vertex service-account key (chmod 600)
  .env                    # chmod 600
  docker-compose.yml
```

`.env` — reuse your Atlas URL, generate a fresh strong JWT, enable Vertex:
```
NODE_ENV=production
PORT=5000
JWT_SECRET=<openssl rand -hex 32>          # must be >=32 chars or the server won't boot
MONGO_CONNECTION_URL=<your Atlas mongodb+srv URL>
AI_PROVIDER=gemini
GEMINI_USE_VERTEX=true
GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/sa.json
GEMINI_MODEL=gemini-2.5-flash
CORS_ORIGIN=*
```

The repo ships a tracked, canonical prod compose at **`docker-compose.prod.yml`**
(server-only, loopback bind, Atlas + Vertex, `HEALTHCHECK`, capped logs). It uses
`context: ./packages/server`, so run it from a full repo checkout on the VM with
`.env` + `credentials/sa.json` at the repo root:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
**Make sure `./credentials/sa.json` exists as a FILE before `up`** — otherwise the
bind mount silently creates a *directory* and Vertex auth fails at call time.

The minimal `~/bhashajs/` layout below mirrors that file for a non-repo checkout
(`build: ./server`, with `.env` + `credentials/` as siblings):
```yaml
services:
  server:
    build: ./server
    restart: unless-stopped
    env_file: ./.env
    ports:
      - "127.0.0.1:5000:5000"
    volumes:
      - ./credentials/sa.json:/app/credentials/sa.json:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:5000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
```

### Build, run, and proxy
```bash
cd ~/bhashajs
docker builder prune -af          # if disk is tight
docker compose up -d --build
curl localhost:5000/api/health    # -> {"success":true,"data":{"status":"ok"}}
```
Add a Caddy block to `/etc/caddy/Caddyfile` and reload (graceful — other sites unaffected):
```
api.bhashajs.com {
    encode gzip
    reverse_proxy localhost:5000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
}
```
```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```
DNS already points at the VM, so Caddy issues the TLS cert automatically.
`https://api.bhashajs.com/api/health` should respond.

> **Vertex AI:** enable the Vertex AI API in the GCP project and grant the
> service account the **Vertex AI User** role. The `sa.json` is mounted read-only
> and `GOOGLE_APPLICATION_CREDENTIALS` points Application Default Credentials at it.

### Atlas access
Allow the VM's public IP in Atlas → Network Access (or `0.0.0.0/0` for a
dev/beta cluster; lock it down to the VM's IP later).

---

## 3. Dashboard on Vercel (`app.bhashajs.com`) — 5 min

1. Go to **[vercel.com](https://vercel.com)** → sign up with GitHub.
2. **Add New → Project** → import your `bhashajs` repo.
3. **Configure:**
   - **Root Directory**: `packages/dashboard`
   - **Framework Preset**: Vite (auto-detected)
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `dist` (default)
4. **Environment Variables:**
   ```
   VITE_API_URL=https://api.bhashajs.com/api
   ```
5. Deploy. Vercel gives you a `*.vercel.app` URL.
6. **Settings → Domains** → add `app.bhashajs.com`. Follow Vercel's DNS instructions (the CNAME you already added in step 1 covers this).

---

## 4. Marketing site on Vercel (`bhashajs.com`) — 5 min

Same flow as the dashboard, different root directory.

1. **Add New → Project** → import the same `bhashajs` repo (Vercel allows multiple projects per repo).
2. **Configure:**
   - **Root Directory**: `packages/landing`
   - **Framework Preset**: Astro (auto-detected)
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `dist` (default)
3. No environment variables needed for the marketing site.
4. Deploy.
5. **Settings → Domains** → add both `bhashajs.com` AND `www.bhashajs.com` (Vercel handles the redirect from www to root).

---

## 5. Smoke test (5 min)

After all three deploys + DNS propagation:

| URL | Expected |
|-----|---------|
| `https://bhashajs.com` | Marketing landing page |
| `https://bhashajs.com/docs/quickstart/` | Docs page renders |
| `https://app.bhashajs.com/login` | Dashboard login screen |
| `https://api.bhashajs.com/api/health` | `{"success":true,"data":{"status":"ok"}}` |

Then end-to-end:
1. On `app.bhashajs.com`, register an account.
2. Create a project with English + Hindi.
3. Copy the API key from project settings.
4. From a fresh local folder:
   ```bash
   mkdir test-bhasha && cd test-bhasha
   npm init -y
   npm install bhasha-js react react-dom
   ```
5. Write a tiny test app using your real `projectKey`. Visit it. Should fetch translations from your live API.

---

## 6. Vercel project settings — make `master` push auto-deploy

Both Vercel projects auto-deploy on push to `master` by default. Confirm:
- Marketing project → Settings → Git → Production Branch should be `master`.
- Dashboard project → same.

For the GCP backend: redeploy is manual — copy the updated `packages/server` to `~/bhashajs/server` and run `docker compose up -d --build` (consider a small deploy script or a GitHub Actions SSH workflow to automate it).

---

## 7. Recommended next-day items (post-launch)

- **Atlas IP whitelist**: lock down `0.0.0.0/0` to the GCP VM's public IP (reserve a static external IP for the VM so it doesn't change).
- **MongoDB backups**: enable Atlas continuous backup, or schedule `scripts/backup.sh` daily via cron (`mongodump --archive --gzip`, keeps the newest 14 — needs `mongodb-database-tools` on the host).
- **Uptime + alerting**: point UptimeRobot / Better Stack at `https://api.bhashajs.com/api/health` (returns 503 when Mongo is down). The container `HEALTHCHECK` auto-restarts a degraded server, but only an external monitor pages *you*.
- **Migrations**: schema migrations don't auto-run anymore — back up, then set `RUN_MIGRATIONS=true` for one boot to apply a pending one.
- **Vercel analytics**: free tier gives basic traffic data — turn it on for both Vercel projects.
- **Plausible / Fathom on the marketing site**: privacy-friendly analytics, ~$9/mo.
- **NPM badges**: once the package has a few weekly downloads, the README badges (already in place) show momentum.
- **Submit to lists**: awesome-react-components, awesome-i18n. The `description` + `keywords` in `package.json` are already SEO-tuned.

---

## Costs — running estimate

| Component | Provider | Plan | Cost/mo |
|-----------|----------|------|---------|
| Marketing site | Vercel | Hobby | $0 |
| Dashboard | Vercel | Hobby | $0 |
| Backend API | GCP | e2-small VM | ~$13/mo (covered by the $300 credit for ~2 yrs) |
| AI translation | Vertex AI | gemini-2.5-flash | usage-based, billed to the GCP credit |
| MongoDB | Atlas | M0 Free | $0 |
| Domain | Namecheap | bhashajs.com | ~$15/year |
| **Total** | | | **~$0/mo while the GCP credit lasts** |

The GCP $300 free credit covers the VM + Vertex AI usage for a long runway.
