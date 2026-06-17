/**
 * stripe.ts — lazily-initialised Stripe client + shared billing helpers.
 *
 * All Stripe access goes through getStripe() so the rest of the app can be
 * imported/tested without a key present (it only throws when actually used).
 */

import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  _stripe = new Stripe(key);
  return _stripe;
}

/** True when the minimum Stripe config is present. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

export function getPriceId(): string {
  const id = process.env.STRIPE_PRICE_ID;
  if (!id) throw new Error('STRIPE_PRICE_ID is not configured');
  return id;
}

/** Frontend base URL for Checkout success/cancel redirects (no trailing slash). */
export function getFrontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/$/, '');
}
