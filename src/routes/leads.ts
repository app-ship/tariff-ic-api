/**
 * Public lead-capture routes — no bearer token required (mounted before
 * authMiddleware) so logged-out visitors on the pricing page can submit.
 *
 *   POST /leads/enterprise  { companyName, companySize, useCase, expectedVolume, contactName, email }
 *     → saves an EnterpriseLead and notifies all admin users in-app.
 */

import { Router, type Request, type Response } from 'express';
import { EnterpriseLead } from '../models/EnterpriseLead.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { isDBConnected } from '../db.js';

export const leadsRouter = Router();

leadsRouter.post('/enterprise', async (req: Request, res: Response) => {
  const {
    companyName, companySize, useCase, expectedVolume, contactName, email,
  } = req.body as {
    companyName?:    string;
    companySize?:    string;
    useCase?:        string;
    expectedVolume?: string;
    contactName?:    string;
    email?:          string;
  };

  if (!companyName?.trim() || !contactName?.trim() || !email?.trim()) {
    res.status(400).json({ error: 'companyName, contactName, and email are required.' });
    return;
  }

  if (!isDBConnected()) {
    res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
    return;
  }

  const lead = await EnterpriseLead.create({
    companyName:    companyName.trim(),
    companySize:    (companySize ?? '').trim(),
    useCase:        (useCase ?? '').trim(),
    expectedVolume: (expectedVolume ?? '').trim(),
    contactName:    contactName.trim(),
    email:          email.trim().toLowerCase(),
    source:         'pricing',
    status:         'new',
  });

  // Notify every admin in-app — fire-and-forget, never block the response.
  User.find({ role: 'admin' }).select('_id orgId').lean()
    .then((admins) =>
      Promise.all(admins.map((admin) =>
        Notification.create({
          orgId:  String(admin.orgId),
          userId: String(admin._id),
          type:   'analysis',
          title:  'New Enterprise lead',
          body:   `${companyName.trim()} (${contactName.trim()}, ${email.trim()}) requested an Enterprise quote.`,
          status: 'complete',
        }),
      )),
    )
    .catch((err: Error) => console.error('[leads] admin notification failed:', err));

  res.status(201).json({ ok: true, leadId: String(lead._id) });
});
