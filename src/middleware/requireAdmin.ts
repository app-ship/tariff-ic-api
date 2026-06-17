import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that only allows requests from users with role === 'admin'.
 * Must be mounted after authMiddleware (req.tenant.role must be set).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.tenant?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}
