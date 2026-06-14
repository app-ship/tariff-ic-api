/**
 * Monitor routes — CRUD for tariff monitors + on-demand check.
 *
 * All endpoints require a valid bearer token (enforced by the global
 * authMiddleware before this router is mounted). The cron endpoint lives in
 * monitorCron.ts and is mounted BEFORE authMiddleware (secret-guarded).
 */

import { Router } from 'express';
import { isDBConnected } from '../db.js';
import { TariffMonitor } from '../models/TariffMonitor.js';
import { User } from '../models/User.js';
import {
  buildBaselineSnapshot,
  checkMonitor,
  computeNextCheckAt,
} from '../services/monitorChecker.js';

export const monitorRouter = Router();

function dbGuard(res: import('express').Response): boolean {
  if (!isDBConnected()) {
    res.status(503).json({ error: 'Database unavailable' });
    return false;
  }
  return true;
}

// ── List ──────────────────────────────────────────────────────────────────────
monitorRouter.get('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    if (!isDBConnected()) return res.json({ items: [] });

    const items = await TariffMonitor
      .find({ orgId, userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// ── Create ──────────────────────────────────────────────────────────────────
monitorRouter.post('/', async (req, res, next) => {
  try {
    if (!dbGuard(res)) return;
    const { orgId, userId } = req.tenant;
    const body = req.body ?? {};

    const htsCode      = String(body.htsCode ?? '').trim();
    const materialName = String(body.materialName ?? '').trim();
    const countries    = Array.isArray(body.countries)
      ? body.countries.map((c: unknown) => String(c).trim()).filter(Boolean)
      : [];

    if (!htsCode)      return res.status(400).json({ error: 'htsCode is required' });
    if (!materialName) return res.status(400).json({ error: 'materialName is required' });
    if (!countries.length) return res.status(400).json({ error: 'At least one country is required' });

    const frequency: 'daily' | 'weekly' = body.frequency === 'weekly' ? 'weekly' : 'daily';
    const channels = {
      inApp: body.channels?.inApp !== false,            // default on
      email: body.channels?.email === true,             // default off (MVP: not yet sent)
    };

    // Default the email address to the user's account email
    let emailAddress: string | undefined = body.emailAddress ? String(body.emailAddress) : undefined;
    if (!emailAddress) {
      const user = await User.findById(userId).select('email').lean();
      emailAddress = user?.email;
    }

    // Compute the initial baseline up-front (cheap, deterministic). If the engine
    // is unavailable, create with an empty baseline + immediate nextCheckAt so the
    // cron run seeds it on the next tick.
    let baseline = [] as Awaited<ReturnType<typeof buildBaselineSnapshot>>;
    let nextCheckAt = computeNextCheckAt(frequency);
    try {
      baseline = await buildBaselineSnapshot(htsCode, countries, {
        casNumber: body.casNumber ? String(body.casNumber) : undefined,
        materialName,
      });
    } catch (e) {
      console.error('[monitor] initial baseline failed, will seed on next cron:', (e as Error).message);
      nextCheckAt = new Date();
    }

    const doc = await TariffMonitor.create({
      orgId,
      userId,
      materialName,
      htsCode,
      casNumber:      body.casNumber ? String(body.casNumber) : undefined,
      destination:    body.destination ? String(body.destination) : 'USA',
      countries,
      sourceSearchId: body.sourceSearchId ? String(body.sourceSearchId) : undefined,
      frequency,
      channels,
      emailAddress,
      baseline,
      status:        'active',
      lastCheckedAt: baseline.length ? new Date() : undefined,
      nextCheckAt,
    });

    res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
monitorRouter.get('/:id', async (req, res, next) => {
  try {
    if (!dbGuard(res)) return;
    const { orgId } = req.tenant;
    const doc = await TariffMonitor.findOne({ _id: req.params.id, orgId }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// ── Update (prefs / status / countries) ─────────────────────────────────────
monitorRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!dbGuard(res)) return;
    const { orgId } = req.tenant;
    const body = req.body ?? {};

    const existing = await TariffMonitor.findOne({ _id: req.params.id, orgId });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (body.frequency === 'daily' || body.frequency === 'weekly') {
      existing.frequency = body.frequency;
      existing.nextCheckAt = computeNextCheckAt(existing.frequency);
    }
    if (body.status === 'active' || body.status === 'paused') {
      existing.status = body.status;
    }
    if (body.channels) {
      if (typeof body.channels.inApp === 'boolean') existing.channels.inApp = body.channels.inApp;
      if (typeof body.channels.email === 'boolean') existing.channels.email = body.channels.email;
    }
    if (typeof body.emailAddress === 'string') existing.emailAddress = body.emailAddress;

    // If the country set changes, rebuild the baseline so new countries are seeded.
    if (Array.isArray(body.countries)) {
      const countries = body.countries.map((c: unknown) => String(c).trim()).filter(Boolean);
      if (countries.length && countries.join(',') !== (existing.countries ?? []).join(',')) {
        existing.countries = countries;
        try {
          existing.baseline = await buildBaselineSnapshot(existing.htsCode, countries, {
            casNumber: existing.casNumber, materialName: existing.materialName,
          });
          existing.lastCheckedAt = new Date();
        } catch {
          existing.nextCheckAt = new Date();
        }
      }
    }

    await existing.save();
    res.json(existing.toObject());
  } catch (err) {
    next(err);
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
monitorRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!dbGuard(res)) return;
    const { orgId } = req.tenant;
    const result = await TariffMonitor.deleteOne({ _id: req.params.id, orgId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Check now ─────────────────────────────────────────────────────────────────
monitorRouter.post('/:id/check', async (req, res, next) => {
  try {
    if (!dbGuard(res)) return;
    const { orgId } = req.tenant;
    const monitor = await TariffMonitor.findOne({ _id: req.params.id, orgId });
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const result = await checkMonitor(monitor);
    const updated = await TariffMonitor.findById(monitor._id).lean();
    res.json({ result, monitor: updated });
  } catch (err) {
    next(err);
  }
});
