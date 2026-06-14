# tariff-ic-api

Lightweight proxy / BFF (Backend-for-Frontend) that sits between the **Tariff-ic UI** and the shared **deep-research** FastAPI service.

## Architecture

```
Tariff-ic UI (Vue/Vite :5174)
        │
        │  /tariff-api/*  (Vite proxy in dev, direct URL in prod)
        ▼
tariff-ic-api (Express/TS :3002)   ← THIS REPO
   • Custom Auth0 login/signup (ROPG)
   • JWT verification (Auth0 RS256)
   • User/org provisioning (MongoDB)
   • Tenant injection (org_id, user_id)
        │
        │  HTTP
        ▼
deep-research (FastAPI :8979)      ← shared, not forked
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| POST | `/auth/login` | — | Email/password login → access token |
| POST | `/auth/register` | — | Sign up → access token |
| POST | `/auth/bootstrap` | Bearer | Provision user + org in MongoDB |
| GET | `/auth/me` | Bearer | Current user/org info |
| PUT | `/auth/tour-progress` | Bearer | Persist onboarding progress |
| POST | `/classify` | Bearer | HTS classification |
| POST | `/analyze` | Bearer | Tariff calculation |
| POST | `/resolve` | Bearer | Material resolve |
| GET | `/history` | Bearer | Tariff search history |
| GET | `/validate-cas/:cas` | Bearer | Validate CAS number |
| GET | `/searches` | Bearer | Material search history (paginated) |
| GET | `/monitor` | Bearer | List tariff monitors for the tenant |
| POST | `/monitor` | Bearer | Create a monitor (computes initial baseline) |
| GET | `/monitor/:id` | Bearer | Monitor detail (baseline + change history) |
| PATCH | `/monitor/:id` | Bearer | Update prefs / status / countries |
| DELETE | `/monitor/:id` | Bearer | Delete a monitor |
| POST | `/monitor/:id/check` | Bearer | Run a hybrid check now |
| POST | `/monitor/cron/run` | `X-CRON-SECRET` | Process due monitors (Cloud Scheduler) |
| GET | `/notifications` | Bearer | In-app inbox + unread count |
| POST | `/notifications/:id/read` | Bearer | Mark one read |
| POST | `/notifications/read-all` | Bearer | Mark all read |

## Monitor (tariff-change tracking)

Users can monitor an HTS code across sourcing countries and get in-app alerts
when tariffs move. Detection is **hybrid**:

1. **Cheap baseline check** (every due tick): calls deep-research
   `POST /material/tariff/baseline` (deterministic, no AI) and diffs base MFN
   rate + active-rule signature against the stored snapshot.
2. **Full re-analysis** (on a baseline delta, or weekly): calls
   `POST /material/tax-rate/parallel/fast` (rates-only) per country and diffs the
   effective rate. On a confirmed change we create an in-app `Notification`,
   append to the monitor's `changeHistory`, and refresh its baseline.

Per-material cadence is **daily** or **weekly** (`frequency`). Email channel
fields exist in the schema/UI but are not yet delivered (in-app only for now).

### Scheduling (Cloud Scheduler)

The cron endpoint is mounted **before** auth and guarded by the `CRON_SECRET`
shared secret. Schedule it every 6 hours; each tick processes monitors whose
`nextCheckAt` is due (honoring per-material daily/weekly cadence):

```bash
gcloud scheduler jobs create http tariff-monitor-check \
  --schedule="0 */6 * * *" \
  --uri="https://<tariff-ic-api-host>/monitor/cron/run" \
  --http-method=POST \
  --headers="X-CRON-SECRET=$CRON_SECRET" \
  --location=<region>
```

Local smoke test:

```bash
curl -s -X POST http://localhost:3002/monitor/cron/run \
  -H "X-CRON-SECRET: $CRON_SECRET" | jq .
```

## Local development

### 1. Configure environment

```bash
cp .env.example .env
# Fill in AUTH0_CLIENT_SECRET and MONGODB_URI
```

Required variables:

| Variable | Description |
|----------|-------------|
| `AUTH0_ISSUER_BASE_URL` | Auth0 tenant issuer (e.g. `https://tarrif.us.auth0.com`) |
| `AUTH0_AUDIENCE` | API identifier (e.g. `https://api.tariffic.ai`) |
| `AUTH0_CLIENT_ID` | M2M backend client ID (password grant enabled) |
| `AUTH0_CLIENT_SECRET` | M2M backend client secret |
| `AUTH0_DB_CONNECTION` | Auth0 DB connection (default: `Username-Password-Authentication`) |
| `MONGODB_URI` | MongoDB connection string |
| `DEEP_RESEARCH_URL` | deep-research base URL (default: `http://127.0.0.1:8979`) |
| `CORS_ORIGINS` | Frontend origin (default: `http://localhost:5174`) |
| `CRON_SECRET` | Shared secret for `POST /monitor/cron/run` (Cloud Scheduler). Blank in dev = unguarded |

### 2. Start the API

```bash
npm install
npm run dev        # tsx watch — hot reload on :3002
```

### 3. Start the frontend (separate terminal)

```bash
cd ../tariffy-ai
cp .env.example .env
npm install
npm run dev        # Vite dev server on :5174
```

### 4. Test auth flow

1. Open http://localhost:5174/login
2. Sign in with an Auth0 user (or sign up at http://localhost:5174/signup)
3. The UI calls `POST /auth/login` → stores token → `POST /auth/bootstrap` → redirects to app

Quick smoke test via curl:

```bash
curl -s http://localhost:3002/health | jq .

curl -s -X POST http://localhost:3002/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq .
```

## Auth

Production uses Auth0 RS256 JWT verification via JWKS. The UI obtains tokens through the backend's `/auth/login` and `/auth/register` endpoints (Resource Owner Password Grant).

If `AUTH0_ISSUER_BASE_URL` is unset and `NODE_ENV !== 'production'`, requests bypass auth with `DEFAULT_ORG_ID` / `DEFAULT_USER_ID` (legacy dev mode — not used when Auth0 is configured).

## Production checklist

- [ ] Set `AUTH0_CLIENT_SECRET` via Secret Manager (not in env files)
- [ ] Set `MONGODB_URI` via Secret Manager
- [ ] Set `CORS_ORIGINS` to your deployed frontend URL
- [ ] Set `DEEP_RESEARCH_URL` to the Cloud Run / production URL
- [ ] Do **not** commit `.env`
