# Deployment guide — bhashajs.com

Step-by-step for going live tonight. Three things deploy independently:

1. **Marketing site** → `bhashajs.com` (Vercel)
2. **Dashboard** → `app.bhashajs.com` (Vercel)
3. **Backend API** → `api.bhashajs.com` (Railway)

Plus your existing **MongoDB Atlas** stays where it is.

---

## 0. Before anything: publish `bhasha-js@0.1.0-beta.2` to npm

The fixed SDK is ready. Build is verified, all 188 tests pass.

```bash
cd packages/sdk

# Log in if you aren't already
npm login

# Publish — the version, build, and tarball are all ready
npm publish --tag beta
```

Verify:
```bash
npm view bhasha-js@beta
# Should show 0.1.0-beta.2
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

## 2. Backend on Railway (`api.bhashajs.com`) — 15 min

### Why Railway?
- Deploys directly from your existing `Dockerfile` in `packages/server`.
- $5/mo on the Hobby plan, includes $5 of usage credit. Likely free for your beta traffic.
- Custom domain + auto-SSL with one click.

### Steps

1. Go to **[railway.com](https://railway.com)** → sign up with GitHub.
2. **New Project → Deploy from GitHub Repo**, select your `bhashajs` repo.
3. After it imports, go to the service settings:
   - **Root Directory**: `packages/server`
   - **Build Command**: leave default (Railway detects the Dockerfile)
   - **Start Command**: leave default
4. **Variables** tab — add these (paste your real values from `packages/server/.env` locally — never commit them):
   ```
   MONGO_CONNECTION_URL=<your-atlas-connection-string>
   JWT_SECRET=<generate-with-openssl-rand-hex-32>
   GEMINI_API_KEY=<your-gemini-api-key>
   PORT=5000
   JWT_EXPIRY=7d
   AI_PROVIDER=gemini
   CORS_ORIGIN=https://bhashajs.com,https://app.bhashajs.com
   ```
   > **Generate a fresh JWT secret for production**: `openssl rand -hex 32`. Don't reuse the dev one.
   > **Don't reuse your dev Mongo password** if it was ever committed anywhere — rotate it in Atlas first.
5. **Settings → Networking → Generate Domain** → Railway gives you something like `bhashajs-server-production.up.railway.app`. Test it: `https://that-url/api/health` should return `{"success":true}`.
6. **Settings → Networking → Custom Domain** → enter `api.bhashajs.com`. Railway shows a CNAME target — copy it back into Namecheap as the `api` CNAME value (replacing the placeholder you put in step 1).
7. Wait for SSL to provision (~2 min). Then `https://api.bhashajs.com/api/health` should respond.

### Atlas access
Your Atlas cluster needs to allow Railway's IPs. The lazy-but-fine option:
- Atlas → Network Access → Add IP Address → **Allow access from anywhere** (`0.0.0.0/0`).
- This is acceptable for a dev/beta cluster. Lock it down later by whitelisting Railway's egress IP range.

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
   npm install bhasha-js@beta react react-dom
   ```
5. Write a tiny test app using your real `projectKey`. Visit it. Should fetch translations from your live API.

---

## 6. Vercel project settings — make `master` push auto-deploy

Both Vercel projects auto-deploy on push to `master` by default. Confirm:
- Marketing project → Settings → Git → Production Branch should be `master`.
- Dashboard project → same.

For Railway: Settings → Service → Source → "Auto Deploy on Push" toggle should be on.

---

## 7. Recommended next-day items (post-launch)

- **Atlas IP whitelist**: lock down `0.0.0.0/0` to Railway's egress range. (Look up "Railway egress IP" in their docs.)
- **MongoDB backups**: enable Atlas continuous backup on the free tier or schedule a daily `mongodump`.
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
| Backend API | Railway | Hobby | $5 (incl. $5 credit) |
| MongoDB | Atlas | M0 Free | $0 |
| Domain | Namecheap | bhashajs.com | ~$15/year |
| **Total** | | | **~$5/mo** |

Sustainable for years on this stack.
