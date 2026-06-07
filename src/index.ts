/**
 * tariff-ic-api — proxy / BFF between the Tariff-ic UI and deep-research
 *
 * Routes (all authenticated):
 *   POST /classify      → deep-research /material/classification/parallel/fast
 *   POST /analyze       → deep-research /material/tax-rate/parallel/fast
 *   POST /resolve       → deep-research /material/resolve
 *   GET  /history       → deep-research /material/tariff/searches
 *   GET  /validate-cas/:cas → deep-research /material/validate-cas/:cas
 *   GET  /health        → 200 OK (unauthenticated)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { authMiddleware } from './middleware/auth.js';
import { errorHandler }   from './middleware/errorHandler.js';
import { classifyRouter }    from './routes/classify.js';
import { analyzeRouter }     from './routes/analyze.js';
import { resolveRouter }     from './routes/resolve.js';
import { historyRouter }     from './routes/history.js';
import { validateCasRouter } from './routes/validateCas.js';

const app  = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

// ── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body / logging ────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));   // base64 images can be large
app.use(morgan('dev'));

// ── Health check (no auth) ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'tariff-ic-api',
    upstream: process.env.DEEP_RESEARCH_URL || 'http://127.0.0.1:8979',
    ts: new Date().toISOString(),
  });
});

// ── Authenticated routes ──────────────────────────────────────────────────
app.use(authMiddleware);

app.use('/classify',     classifyRouter);
app.use('/analyze',      analyzeRouter);
app.use('/resolve',      resolveRouter);
app.use('/history',      historyRouter);
app.use('/validate-cas', validateCasRouter);

// ── Global error handler ──────────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`tariff-ic-api running on http://localhost:${PORT}`);
  console.log(`  → upstream: ${process.env.DEEP_RESEARCH_URL || 'http://127.0.0.1:8979'}`);
  const authMode = process.env.API_KEY
    ? 'API key'
    : process.env.JWT_SECRET
    ? 'JWT'
    : 'DEV BYPASS (no auth configured)';
  console.log(`  → auth mode: ${authMode}`);
});
