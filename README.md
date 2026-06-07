# tariff-ic-api

Lightweight proxy / BFF (Backend-for-Frontend) that sits between the **Tariff-ic UI** and the shared **deep-research** FastAPI service.

## Architecture

```
Tariff-ic UI (Vue/Vite :5174)
        │
        │  /tariff-api/*  (Vite proxy in dev, direct URL in prod)
        ▼
tariff-ic-api (Express/TS :3002)   ← THIS REPO
   • Auth validation (API key or JWT)
   • Tenant injection (org_id, user_id)
   • bypass_cache + async_mode defaults
        │
        │  HTTP
        ▼
deep-research (FastAPI :8979)      ← shared, not forked
```

## Endpoints

| Method | Path | Proxies to |
|--------|------|-----------|
| GET | `/health` | — (unauthenticated) |
| POST | `/classify` | `/material/classification/parallel/fast` |
| POST | `/analyze` | `/material/tax-rate/parallel/fast` |
| POST | `/resolve` | `/material/resolve` |
| GET | `/history` | `/material/tariff/searches` |
| GET | `/validate-cas/:cas` | `/material/validate-cas/:cas` |

## Quick start

```bash
cp .env.example .env
# Edit .env — set DEEP_RESEARCH_URL to your deep-research instance
npm install
npm run dev        # tsx watch — hot reload on :3002
```

## Auth

Three modes (checked in order):

1. **API key** — send `X-Api-Key: <key>` header. Set `API_KEY` in `.env`.
2. **JWT** — send `Authorization: Bearer <token>`. Set `JWT_SECRET` in `.env`.
3. **Dev bypass** — if neither `API_KEY` nor `JWT_SECRET` is set, all requests pass through (local dev only).

Tenant (`org_id`, `user_id`) is extracted from the token / headers and stamped on every upstream request automatically.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Server port |
| `DEEP_RESEARCH_URL` | `http://127.0.0.1:8979` | deep-research base URL |
| `API_KEY` | — | Static API key for client auth |
| `JWT_SECRET` | — | Secret for HS256 JWT validation |
| `DEFAULT_ORG_ID` | `tariffic-dev-org` | Fallback org ID (dev) |
| `DEFAULT_USER_ID` | `tariffic-dev-user` | Fallback user ID (dev) |
| `CORS_ORIGINS` | `http://localhost:5174` | Comma-separated allowed origins |

## Production checklist

- [ ] Set a strong random `API_KEY`
- [ ] Set `CORS_ORIGINS` to your deployed frontend URL
- [ ] Set `DEEP_RESEARCH_URL` to the Cloud Run / production URL
- [ ] Do **not** commit `.env`
