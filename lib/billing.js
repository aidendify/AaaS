// Billing webhooks (groundwork for Razorpay; not wired to any route yet).
// Razorpay signs every webhook: header X-Razorpay-Signature = hex HMAC-SHA256 of the RAW request body, keyed with the
// webhook secret set in the Razorpay dashboard (RAZORPAY_WEBHOOK_SECRET). Verify on the raw bytes, before JSON.parse,
// and compare in constant time. Duplicate deliveries carry the same x-razorpay-event-id: process each id once.
import crypto from 'node:crypto';

export function razorpaySignature(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret)).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')).digest('hex');
}

export function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!secret || !signature || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const want = Buffer.from(razorpaySignature(rawBody, secret), 'hex');
  const got = Buffer.from(signature.trim().toLowerCase(), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Checks a delivery and returns the parsed event, or throws with a status code for the HTTP layer.
// seen(eventId) → true if already processed (store-backed in the real route).
export async function readRazorpayWebhook({ rawBody, headers = {}, secret, seen = async () => false }) {
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  if (!verifyRazorpaySignature(rawBody, h('x-razorpay-signature'), secret)) { const e = new Error('bad signature'); e.status = 400; throw e; }
  let event; try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { const e = new Error('bad json'); e.status = 400; throw e; }
  const id = String(h('x-razorpay-event-id') || '');
  if (id && await seen(id)) return { duplicate: true, id, event };
  return { duplicate: false, id, event };
}
