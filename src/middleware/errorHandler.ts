import type { Request, Response, NextFunction } from 'express';
import type { AxiosError } from 'axios';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const axiosErr = err as AxiosError;

  if (axiosErr.isAxiosError) {
    const status  = axiosErr.response?.status  ?? 502;
    const data    = axiosErr.response?.data    ?? { error: 'Bad gateway — deep-research unavailable' };
    res.status(status).json(data);
    return;
  }

  console.error('[tariff-ic-api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
