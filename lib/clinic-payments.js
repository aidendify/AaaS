// Clinic invoice payment links. Razorpay Payment Links in test mode, or a UPI deep link when keys are absent.
// Keys stay in the environment. This file never writes them into an invoice, a log line, or a draft.
// Demo accounts do not call Razorpay. A signed webhook is what marks a live invoice paid.
const LINKS_URL = 'https://api.razorpay.com/v1/payment_links';

export function paymentEnv(env = process.env) {
  const keyId = String(env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = String(env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  const test = keyId.startsWith('rzp_test_') && keySecret.length > 0;
  return {
    keyId: test ? keyId : '',
    keySecret: test ? keySecret : '',
    webhookSecret,
    configured: test,
    liveBlocked: keyId.startsWith('rzp_live_'),
  };
}

// Mock links only when the AI mock is already on, so a real server cannot invent a Razorpay URL.
export function payMockOn(env = process.env) {
  const mock = String(env.AI_PROVIDER || '').toLowerCase() === 'mock' && String(env.AI_MOCK || '').toLowerCase() === 'on';
  return mock && String(env.CLINIC_PAY_MOCK || '').toLowerCase() === 'on';
}

export function upiDeepLink({ vpa, name, amount, note }) {
  const pa = String(vpa || '').trim();
  if (!/^[\w.\-]{2,40}@[\w.\-]{2,64}$/.test(pa)) return '';
  const am = Number(amount);
  const parts = ['pa=' + encodeURIComponent(pa), 'pn=' + encodeURIComponent(String(name || 'AaaS').slice(0, 50))];
  if (Number.isFinite(am) && am > 0) parts.push('am=' + am.toFixed(2));
  parts.push('cu=INR');
  if (note) parts.push('tn=' + encodeURIComponent(String(note).slice(0, 50)));
  return 'upi://pay?' + parts.join('&');
}

export function paymentLinkId(event) {
  const ent = event && event.payload && event.payload.payment_link && event.payload.payment_link.entity;
  return ent && ent.id ? String(ent.id) : '';
}

export async function createRazorpayLink({ amountInr, description, name, phone, email, reference, fetchImpl, env = process.env }) {
  const cfg = paymentEnv(env);
  if (!cfg.configured) return null;
  const ref = String(reference || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'invoice';
  if (payMockOn(env)) {
    return { id: 'plink_mock' + ref, url: 'https://rzp.io/i/mock' + ref, mode: 'razorpay', test: true };
  }
  const amount = Math.round(Number(amountInr) * 100);
  if (!Number.isFinite(amount) || amount < 100) throw Object.assign(new Error('Razorpay needs at least ₹1.'), { status: 400 });
  const customer = {};
  if (name) customer.name = String(name).slice(0, 50);
  const contact = String(phone || '').replace(/\D/g, '').slice(0, 15);
  if (contact.length >= 10) customer.contact = contact;
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) customer.email = email;
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw Object.assign(new Error('This server cannot call Razorpay.'), { status: 500 });
  const auth = Buffer.from(cfg.keyId + ':' + cfg.keySecret).toString('base64');
  let res;
  try {
    res = await fetchFn(LINKS_URL, {
      method: 'POST',
      headers: { authorization: 'Basic ' + auth, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        amount, currency: 'INR', accept_partial: false,
        description: String(description || 'Invoice').slice(0, 200),
        customer, notify: { sms: false, email: false }, reminder_enable: false,
        reference_id: ref,
        notes: { reference: ref },
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw Object.assign(new Error('Razorpay did not answer.'), { status: 502 });
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || !data.short_url || !data.id) throw Object.assign(new Error('Razorpay did not create a payment link.'), { status: res.status >= 400 && res.status < 500 ? 400 : 502 });
  return { id: String(data.id), url: String(data.short_url), mode: 'razorpay', test: true };
}

// Fills inv.payLink. Demo never calls out. A failed Razorpay call falls back to UPI.
export async function attachPayment(c, inv, patient, { amount, st, email, env, fetchImpl } = {}) {
  const upi = upiDeepLink({ vpa: inv.upi, name: c && c.biz, amount, note: inv.number });
  if (c && c.demo) {
    inv.payMode = 'demo';
    inv.payLink = upi || inv.payLink || '';
    inv.payId = 'demo_' + String(inv.number || inv.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    return inv;
  }
  const cfg = paymentEnv(env);
  if (cfg.configured) {
    try {
      const link = await createRazorpayLink({
        amountInr: amount, description: (c && c.biz ? c.biz + ' ' : '') + (inv.number || 'invoice'),
        name: patient && patient.name, phone: patient && patient.phone, email: patient && patient.email,
        reference: inv.number, fetchImpl, env,
      });
      if (link && link.url && /^plink_[A-Za-z0-9]+$/.test(link.id)) {
        inv.payMode = 'razorpay';
        inv.payLink = link.url;
        inv.payId = link.id;
        c.payIds = Array.isArray(c.payIds) ? c.payIds : [];
        if (!c.payIds.includes(link.id)) c.payIds.push(link.id);
        if (st && email) await st.put('as_cpay:' + link.id, JSON.stringify({ email, invoiceId: inv.id }), Date.now());
        return inv;
      }
    } catch { /* UPI fallback below. The error text is not kept: it must not carry a key. */ }
  }
  inv.payMode = 'upi';
  inv.payLink = upi || inv.payLink || '';
  inv.payId = '';
  return inv;
}
