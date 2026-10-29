// Clinic staff logins (P1-3). Several logins per business without the agency white-label.
// Owner (the account that owns the clinic) invites staff by email; each staff member signs up with a
// normal customer account and accepts the invite. A member then acts on the owner's clinic with a role:
//   admin  - everything except billing/plan, data delete and team management
//   member - day-to-day work (read, enquiries, appointments, drafts, approve/reject) but no billing,
//            keys, settings, connectors, export or team management
// Roles reuse the names from lib/agency.js. No email is sent: the invite returns a one-time link the
// owner shares (no SES in this path). Only the token hash is stored.
import crypto from 'node:crypto';

export const TEAM_ROLES = ['admin', 'member'];
const TEAM = 'as_cteam:', MEMBER = 'as_cmember:';
const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const INVITE_TTL = 7 * 864e5;

// Paths a member may not call (billing, keys, settings, connectors, data, team admin).
const MEMBER_DENY = [/^\/api\/clinic\/(plan|profile|role|rules|import|checklist|export|tone\/reset|whatsapp\/opt)$/, /^\/api\/clinic\/(setup|connectors|payments|invoices|data|team\/(invite|remove|revoke))(\/|$)/];
const ADMIN_DENY = [/^\/api\/clinic\/(plan|role)$/, /^\/api\/clinic\/(payments|data|team\/(invite|remove|revoke))(\/|$)/];

export function allowed(role, method, pathname) {
  if (role === 'owner') return true;
  const deny = role === 'admin' ? ADMIN_DENY : MEMBER_DENY;
  if (role === 'member' && method === 'GET' && /^\/api\/clinic\/(usage)$/.test(pathname)) return false;
  return !deny.some((re) => re.test(pathname));
}

async function readTeam(st, owner) { return parse((await st.get(TEAM + owner))?.v, null) || { members: [] }; }
async function writeTeam(st, owner, t) { await st.put(TEAM + owner, JSON.stringify(t), Date.now()); }

// Which clinic does this login act on, and as what role.
export async function clinicSeat(st, email) {
  const owner = parse((await st.get(MEMBER + email))?.v, null);
  if (!owner) return { owner: email, role: 'owner' };
  const t = await readTeam(st, owner);
  const m = t.members.find((x) => x.email === email && x.acceptedAt);
  return m ? { owner, role: m.role } : { owner: email, role: 'owner' };
}

const pub = (m) => ({ email: m.email, role: m.role, invitedAt: m.invitedAt, acceptedAt: m.acceptedAt || 0, pending: !m.acceptedAt });

export async function teamRoutes({ method, pathname, st, email, seat, body, HttpError, okEmail, hasClinic }) {
  if (pathname === '/api/clinic/team' && method === 'GET') {
    const t = await readTeam(st, seat.owner);
    return { owner: seat.owner, you: { email, role: seat.role }, members: t.members.map(pub) };
  }
  if (pathname === '/api/clinic/team/invite' && method === 'POST') {
    if (seat.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can invite staff.');
    if (!(await hasClinic(seat.owner))) throw new HttpError(400, 'no_clinic', 'Set up the business first.');
    const to = String(body.email || '').trim().toLowerCase();
    if (!okEmail(to)) throw new HttpError(400, 'bad_email', 'Enter a valid email address.');
    if (to === seat.owner) throw new HttpError(400, 'bad_email', 'You already own this business.');
    const role = TEAM_ROLES.includes(body.role) ? body.role : 'member';
    const other = parse((await st.get(MEMBER + to))?.v, null);
    if (other && other !== seat.owner) throw new HttpError(409, 'taken', 'That person already belongs to another business.');
    const t = await readTeam(st, seat.owner);
    if (t.members.length >= 20) throw new HttpError(400, 'too_many', 'A business can have up to 20 staff logins.');
    const token = crypto.randomBytes(24).toString('base64url');
    const row = { email: to, role, invitedAt: Date.now(), tokenHash: hash(token), acceptedAt: 0 };
    const i = t.members.findIndex((x) => x.email === to);
    if (i >= 0) row.acceptedAt = t.members[i].acceptedAt || 0, t.members[i] = row; else t.members.push(row);
    await writeTeam(st, seat.owner, t);
    // No email provider here: hand the link to the owner to share. Token is shown once.
    return { ok: true, member: pub(row), invite: { token, link: '/clinic?invite=' + token + '&owner=' + encodeURIComponent(seat.owner), owner: seat.owner, sent: false, note: 'Email is not sent yet. Share this link with your staff member; it works once, for 7 days, and only for ' + to + '.' } };
  }
  if (pathname === '/api/clinic/team/accept' && method === 'POST') {
    const token = String(body.token || '');
    const owner = String(body.owner || '').toLowerCase();
    const t = owner ? await readTeam(st, owner) : null;
    const m = t && t.members.find((x) => x.email === email && x.tokenHash && x.tokenHash === hash(token));
    if (!m || Date.now() - m.invitedAt > INVITE_TTL) throw new HttpError(404, 'bad_invite', 'That invite is not valid for this account.');
    const other = parse((await st.get(MEMBER + email))?.v, null);
    if (other && other !== owner) throw new HttpError(409, 'taken', 'You already belong to another business.');
    if (await hasClinic(email)) throw new HttpError(409, 'own_clinic', 'This login already owns a business. Use a different login for staff access.');
    m.acceptedAt = Date.now(); m.tokenHash = '';
    await writeTeam(st, owner, t);
    await st.put(MEMBER + email, JSON.stringify(owner), Date.now());
    return { ok: true, owner, role: m.role };
  }
  if (pathname === '/api/clinic/team/remove' && method === 'POST') {
    if (seat.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can remove staff.');
    const who = String(body.email || '').trim().toLowerCase();
    const t = await readTeam(st, seat.owner);
    const before = t.members.length;
    t.members = t.members.filter((x) => x.email !== who);
    if (t.members.length === before) throw new HttpError(404, 'not_found', 'That person is not on the team.');
    await writeTeam(st, seat.owner, t);
    if (parse((await st.get(MEMBER + who))?.v, null) === seat.owner) { if (st.del) await st.del(MEMBER + who); else await st.put(MEMBER + who, 'null', Date.now()); }
    return { ok: true };
  }
  return undefined;
}
