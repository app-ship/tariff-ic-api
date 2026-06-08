/**
 * MongoDB connection — optimised for Cloud Run (serverless, variable concurrency).
 *
 * The `tariff-ic` database and all collections are created automatically
 * by MongoDB on the first write — no manual setup required.
 * Indexes are declared on the schemas and synced via ensureIndexes() on connect.
 *
 * Pool tuning for Cloud Run:
 *   maxPoolSize  5   — each instance handles modest concurrency
 *   minPoolSize  0   — no pre-warmed connections; scales to zero between requests
 *   maxIdleTimeMS 15s — release idle connections quickly
 *   serverSelectionTimeoutMS 5s — fail fast on Atlas connectivity issues
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI    || '';
const MONGODB_DB  = process.env.MONGODB_DB_NAME || 'tariff-ic';

// Deduplicate concurrent connect calls (critical during cold starts)
let connectPromise: Promise<void> | null = null;

export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  if (!MONGODB_URI) {
    console.warn('[db] MONGODB_URI not set — running without persistence (dev bypass mode)');
    return;
  }

  if (!connectPromise) {
    connectPromise = mongoose
      .connect(MONGODB_URI, {
        dbName:                   MONGODB_DB,
        maxPoolSize:              5,
        minPoolSize:              0,
        maxIdleTimeMS:            15_000,
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS:         10_000,
        socketTimeoutMS:          45_000,
        heartbeatFrequencyMS:     10_000,
      })
      .then(async () => {
        console.log(`[db] Connected → mongodb/${MONGODB_DB}`);
        await ensureIndexes();
      })
      .catch((err) => {
        connectPromise = null;    // allow retry on next request
        console.error('[db] Connection error:', err);
        throw err;
      });
  }

  return connectPromise;
}

/**
 * Sync all schema-declared indexes to MongoDB.
 * MongoDB creates the DB + collections automatically on first write,
 * so no manual database/collection creation is ever needed.
 */
async function ensureIndexes(): Promise<void> {
  // Dynamic import keeps models out of the top-level require cycle
  const { User }         = await import('./models/User.js');
  const { Organization } = await import('./models/Organization.js');
  const { SampleEntry }  = await import('./fixtures/sampleAnalysis.js');

  await Promise.all([
    User.createIndexes(),
    Organization.createIndexes(),
    SampleEntry.createIndexes(),
  ]);

  console.log('[db] Indexes synced (users, organizations, sample_entries)');
}

export function isDBConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
