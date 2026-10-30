// v2.7 spike: shared owner-bound inbound router for Chief (WhatsApp QR, Telegram, Slack, webchat).
// Owner-only: a message from anyone but the linked owner is dropped here (customer routing stays in freech/channels).
// Chief answers from THIS account's clinic records (answerQuestion) — no provider call on this path.
// "Send/tell/reply <peer>: text" never sends. It only queues an approval via holdOutbound.
import { answerQuestion, chiefBrief } from './clinic.js';
import { holdOutbound, isStop, looksLikeInjection } from './channels.js';

const OWNER_CHANNELS = new Set(['whatsapp_qr', 'telegram', 'slack', 'webchat']);
const SEND_RE = /^\s*(?:send|tell|reply to|message)\s+([+\w@.:-]{2,64})\s*[:,-]\s*([\s\S]{1,2000})$/i;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, n);

export function parseSendIntent(text) {
  const m = String(text || '').match(SEND_RE);
  return m ? { to: m[1], body: m[2].trim() } : null;
}

async function readClinic(st, email) {
  try { return JSON.parse((await st.get('as_clinic:' + email))?.v || 'null'); } catch { return null; }
}

// Outbound channel for an approval: WhatsApp QR is owner-only, so customer drafts go to official WhatsApp.
const outboundChannel = (ch) => (ch === 'whatsapp_qr' || ch === 'webchat' ? 'whatsapp' : ch);

export async function routeChiefInbound(st, email, { channel, peer, owner, text }) {
  if (!st || !email) throw new Error('chief-inbound needs a store and the owning account');
  if (!OWNER_CHANNELS.has(channel)) return { route: 'drop', reason: 'channel' };
  if (!owner || String(peer) !== String(owner)) return { route: 'drop', reason: 'not_owner' };
  const msg = clean(text, 2000).trim();
  if (!msg) return { route: 'drop', reason: 'empty' };
  if (isStop(msg)) return { route: 'stopped', reply: 'Okay. Paused.' };
  const intent = parseSendIntent(msg);
  if (intent) {
    const item = await holdOutbound(st, email, {
      channel: outboundChannel(channel), to: intent.to, body: intent.body,
      summary: 'Chief draft via ' + channel + ' to ' + intent.to,
    });
    return { route: 'approval', approval: { id: item.id, status: item.status }, reply: 'Drafted for ' + intent.to + '. It waits for your approval. Nothing was sent.' };
  }
  const c = await readClinic(st, email);
  if (!c) return { route: 'chief', reply: 'Your workspace is not set up yet. Open AaaS to finish setup.' };
  const flagged = looksLikeInjection(msg);
  const reply = (!flagged && answerQuestion(msg, c)) || chiefBrief(c).opener || 'Noted.';
  return { route: 'chief', reply: clean(reply, 4000), flagged };
}
