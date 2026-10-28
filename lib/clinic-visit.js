// Clinic-visit kit: the interview script, the free-pilot terms, and the shape of a saved visit.
// Answers live on the clinic record (as_clinic:<email>) and leave when that record is deleted.
// Saving an answer does not email, text, or charge anyone.

import { inr, SELF_HOSTED_INR, HOSTED_INR, SETUP_INR } from './pricing.js';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const PRICE_ASK = `The two plans are Self-hosted at ${inr(SELF_HOSTED_INR)} a month, plus a one-time setup and install of ${inr(SETUP_INR)} waived on an annual plan, or Hosted at ${inr(HOSTED_INR)} a month. Both use your own AI key. You pay the provider directly. What would make it a yes?`;
const PRICE_TERM = `Self-hosted is ${inr(SELF_HOSTED_INR)} a month plus a one-time setup and install of ${inr(SETUP_INR)}, waived on an annual plan. Hosted is ${inr(HOSTED_INR)} a month, with backups, uptime and updates, and no install. Both plans include the same agents. AI usage is paid by you directly to your provider. This app does not take a card payment.`;

export const VISIT_QUESTIONS = [
  { id: 'q1', n: 1, text: 'How do new patients reach you today, and which channel brings the most?' },
  { id: 'q2', n: 2, text: 'What happens to an enquiry that comes after hours or when reception is busy?' },
  { id: 'q3', n: 3, text: 'Which clinic software do you use, and what do you pay for it?' },
  { id: 'q4', n: 4, text: 'How do you follow up patients who leave a treatment unfinished?' },
  { id: 'q5', n: 5, text: 'Roughly how many no-shows do you get in a week?' },
  { id: 'q6', n: 6, text: 'How do you ask patients for Google reviews or referrals today?' },
  { id: 'q7', n: 7, text: 'Who handles your social media, and what does it cost?' },
  { id: 'q8', n: 8, text: 'How do you know at month-end whether the clinic made a profit?' },
  { id: 'q9', n: 9, text: 'What takes most of your receptionist\'s time that isn\'t patient care?' },
  { id: 'q10', n: 10, text: PRICE_ASK },
];

export const PILOT_TERMS = [
  PRICE_TERM,
  'Reminders, review requests, posts and payment notes stay as drafts until the owner approves them. Approving records the OK and still does not email, text, post, or collect money.',
  'WhatsApp is a link the owner opens on their own phone. There is no SMS and no paid WhatsApp API.',
  'Records stay in this owner account. Another customer cannot read them. Sample rows stay marked demo.',
  'The owner can export the records, or delete them, from Privacy. Deleting the whole account still needs the password.',
  'The team sits beside reception. It does not replace the receptionist, and there is no phone menu.',
  'Either side can stop. Stopping does not send a message to patients.',
];

export function visitView(c) {
  const saved = c && c.visit && c.visit.answers ? c.visit : null;
  return {
    title: 'Clinic visit kit',
    questions: VISIT_QUESTIONS,
    terms: PILOT_TERMS,
    saved: saved ? { at: saved.at, who: saved.who || '', notes: saved.notes || '', answers: saved.answers || {} } : null,
  };
}

export function normalizeVisit(body, now = Date.now()) {
  const raw = body && body.answers && typeof body.answers === 'object' ? body.answers : {};
  const answers = {};
  let filled = 0;
  for (const q of VISIT_QUESTIONS) {
    const v = clip(raw[q.id], 2000);
    answers[q.id] = v;
    if (v.length >= 2) filled++;
  }
  if (body && body.accept !== true && body.accept !== 'yes') {
    throw Object.assign(new Error('Confirm the owner heard the free-pilot terms.'), { status: 400 });
  }
  if (filled < 1) throw Object.assign(new Error('Write at least one answer from the visit.'), { status: 400 });
  return { at: now, who: clip(body && body.who, 80), notes: clip(body && body.notes, 2000), accept: true, answers };
}
