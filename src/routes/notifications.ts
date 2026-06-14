/**
 * Notification routes — in-app inbox for the current user.
 *
 *   GET  /notifications            — paginated list + unread count
 *   POST /notifications/:id/read   — mark one read
 *   POST /notifications/read-all   — mark all read
 *
 * All endpoints require a valid bearer token (global authMiddleware).
 */

import { Router } from 'express';
import { isDBConnected } from '../db.js';
import { Notification } from '../models/Notification.js';

export const notificationsRouter = Router();

// ── List + unread count ─────────────────────────────────────────────────────
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (!isDBConnected()) {
      return res.json({ items: [], total: 0, unread: 0, limit, offset });
    }

    const [items, total, unread] = await Promise.all([
      Notification.find({ orgId, userId }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      Notification.countDocuments({ orgId, userId }),
      Notification.countDocuments({ orgId, userId, read: false }),
    ]);

    res.json({ items, total, unread, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ── Mark one read ───────────────────────────────────────────────────────────
notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });

    const result = await Notification.updateOne(
      { _id: req.params.id, orgId, userId },
      { $set: { read: true } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Mark all read ───────────────────────────────────────────────────────────
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });

    await Notification.updateMany({ orgId, userId, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
