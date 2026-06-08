/**
 * tariff-ic-api — proxy / BFF between the Tariff-ic UI and deep-research
 *
 * Routes:
 *   GET  /health              → 200 OK (unauthenticated)
 *   POST /auth/bootstrap      → provision new user + org
 *   GET  /auth/me             → current user/org info
 *   PUT  /auth/tour-progress  → persist onboarding progress
 *   POST /classify            → deep-research HTS classification
 *   POST /analyze             → deep-research tariff calculation
 *   POST /resolve             → deep-research material resolve
 *   GET  /history             → tariff search history (+sample)
 *   GET  /validate-cas/:cas   → validate CAS number
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { connectDB }         from './db.js';
import { authMiddleware }    from './middleware/auth.js';
import { errorHandler }      from './middleware/errorHandler.js';
import authRoutes            from './routes/auth.js';
import { classifyRouter }    from './routes/classify.js';
import { analyzeRouter }     from './routes/analyze.js';
import { resolveRouter }     from './routes/resolve.js';
import { historyRouter }     from './routes/history.js';
import { validateCasRouter } from './routes/validateCas.js';

const app  = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

// ── Connect DB (non-blocking — app starts even if Mongo is down) ─────────────
connectDB().catch((err) => console.error('[startup] DB connection failed:', err));

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body / logging ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(morgan('dev'));

// ── Health (unauthenticated) ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'tariff-ic-api',
    upstream: process.env.DEEP_RESEARCH_URL || 'http://127.0.0.1:8979',
    ts: new Date().toISOString(),
  });
});

// ── Auth middleware (all routes below require a valid token or dev bypass) ────
app.use(authMiddleware);

// ── Auth routes (bootstrap, me, tour-progress) ───────────────────────────────
app.use('/auth', authRoutes);

// ── Proxy routes ─────────────────────────────────────────────────────────────
app.use('/classify',     classifyRouter);
app.use('/analyze',      analyzeRouter);
app.use('/resolve',      resolveRouter);
app.use('/history',      historyRouter);
app.use('/validate-cas', validateCasRouter);

// ── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`tariff-ic-api running on http://localhost:${PORT}`);
  console.log(`  → upstream: ${process.env.DEEP_RESEARCH_URL || 'http://127.0.0.1:8979'}`);
  const authMode = process.env.AUTH0_ISSUER_BASE_URL
    ? `Auth0 JWKS (${process.env.AUTH0_ISSUER_BASE_URL})`
    : 'DEV BYPASS (AUTH0_ISSUER_BASE_URL not set)';
  console.log(`  → auth mode: ${authMode}`);
});
