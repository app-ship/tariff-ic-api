/**
 * Axios instance pre-configured to talk to the deep-research FastAPI service.
 * All proxy routes use this client — it handles base URL, timeouts, and
 * forwards large JSON bodies (images as base64).
 */

import axios from 'axios';

const DEEP_RESEARCH_URL = process.env.DEEP_RESEARCH_URL || 'http://127.0.0.1:8979';

export const drClient = axios.create({
  baseURL: DEEP_RESEARCH_URL,
  timeout: 120_000,        // 2 min — classification + tariff calls can be slow
  headers: {
    'Content-Type': 'application/json',
  },
  // large payloads (images as base64)
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});
