/**
 * Billing routes (Stripe).
 *
 *   POST /billing/checkout  (authed) → Stripe Checkout session for TariffIC Pro
 *   POST /billing/portal    (authed) → Stripe Billing Portal session (manage/cancel)
 *   POST /billing/webhook   (raw body, signature-verified, mounted in index.ts)
 *
 * The webhook is the source of truth for plan changes: Checkout success upgrades
 * the org to 'pro'; subscription deletion downgrades back to free.
 */

import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { Organization } from '../models/Organization.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { getStripe, getPriceId, getFrontendUrl, isStripeConfigured } from '../services/stripe.js';

export const billingRouter = Router();

// ── POST /billing/checkout ────────────────────────────────────────────────────
billingRouter.post('/checkout', async (req: Request, res: Response, next) => {
  try {
    if (!isStripeConfigured()) {
      res.status(503).json({ error: 'Billing is not configured' });
      return;
    }
    const { orgId, auth0Sub } = req.tenant;
    const stripe = getStripe();

    const org = await Organization.findById(orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    if (org.plan === 'pro') {
      res.status(409).json({ error: 'Already on Pro' });
      return;
    }
    if (org.plan === 'enterprise') {
      // Enterprise is sales-assisted only — never route an Enterprise org through
      // self-serve Stripe Checkout (that would silently downgrade their terms).
      res.status(409).json({ error: 'Your organization is on an Enterprise plan. Contact your account manager for billing changes.' });
      return;
    }

    const user = await User.findOne({ auth0Sub }).select('email name').lean();

    // Reuse an existing Stripe customer or create one keyed to the org.
    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user?.email,
        name:  org.name,
        metadata: { orgId: String(org._id) },
      });
      customerId = customer.id;
      org.stripeCustomerId = customerId;
      await org.save();
    }

    const frontend = getFrontendUrl();
    const session = await stripe.checkout.sessions.create({
      mode:               'subscription',
      customer:           customerId,
      line_items:         [{ price: getPriceId(), quantity: 1 }],
      client_reference_id: String(org._id),
      metadata:           { orgId: String(org._id) },
      subscription_data:  { metadata: { orgId: String(org._id) } },
      allow_promotion_codes: false,
      success_url: `${frontend}/analyze?upgraded=1`,
      cancel_url:  `${frontend}/pricing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// ── POST /billing/portal ──────────────────────────────────────────────────────
billingRouter.post('/portal', async (req: Request, res: Response, next) => {
  try {
    if (!isStripeConfigured()) {
      res.status(503).json({ error: 'Billing is not configured' });
      return;
    }
    const { orgId } = req.tenant;
    const stripe = getStripe();

    const org = await Organization.findById(orgId).select('stripeCustomerId').lean();
    if (!org?.stripeCustomerId) {
      // Org was upgraded manually (admin set-plan) — no Stripe customer exists.
      res.status(400).json({
        error:   'no_stripe_customer',
        message: 'Your subscription is managed by the TariffIC team. To cancel or make changes, email support@infis.ai.',
      });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:    org.stripeCustomerId,
      return_url:  `${getFrontendUrl()}/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// ── Webhook handler (mounted with express.raw in index.ts, before auth) ────────
export async function billingWebhookHandler(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  if (!secret || !sig) {
    res.status(400).send('Webhook not configured');
    return;
  }

  let event: Stripe.Event;
  try {
    // req.body is a Buffer here thanks to express.raw on this route.
    event = getStripe().webhooks.constructEvent(req.body as Buffer, sig, secret);
  } catch (err) {
    console.error('[billing] webhook signature verification failed:', (err as Error).message);
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.client_reference_id || session.metadata?.orgId;
        if (orgId) {
          const update: Record<string, unknown> = {
            plan:               'pro',
            subscriptionStatus: 'active',
          };
          if (session.customer)     update.stripeCustomerId     = String(session.customer);
          if (session.subscription) update.stripeSubscriptionId = String(session.subscription);
          await Organization.updateOne({ _id: orgId }, { $set: update });
          console.log(`[billing] org ${orgId} upgraded to Pro`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
        const update: Record<string, unknown> = {};
        if (periodEnd) update.currentPeriodEnd = new Date(periodEnd * 1000);
        if (sub.status === 'past_due') update.subscriptionStatus = 'past_due';
        else if (sub.status === 'active') update.subscriptionStatus = 'active';
        if (Object.keys(update).length) {
          await Organization.updateOne({ stripeSubscriptionId: sub.id }, { $set: update });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await Organization.updateOne(
          { stripeSubscriptionId: sub.id },
          { $set: { plan: 'sandbox', subscriptionStatus: 'canceled' } },
        );
        console.log(`[billing] subscription ${sub.id} cancelled — org downgraded to free`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer ? String(invoice.customer) : null;
        if (customerId) {
          const org = await Organization.findOne({ stripeCustomerId: customerId })
            .select('_id ownerUserId subscriptionStatus').lean();
          if (org) {
            await Organization.updateOne({ _id: org._id }, { $set: { subscriptionStatus: 'past_due' } });
            // No email infra yet — surface an in-app notification for the owner.
            const owner = await User.findOne({ auth0Sub: org.ownerUserId }).select('_id').lean();
            if (owner) {
              await Notification.create({
                orgId:        String(org._id),
                userId:       String(owner._id),
                type:         'analysis',
                title:        'TariffIC Pro payment failed',
                body:         'Your TariffIC Pro payment failed. Please update your payment method in Settings to keep Pro access.',
                status:       'error',
              });
            }
            console.warn(`[billing] payment failed for org ${org._id}`);
          }
        }
        break;
      }

      default:
        // Ignore unrelated events.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}
