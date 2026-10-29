// P1-3: several logins per business. Owner invites staff; members approve drafts but cannot touch billing, keys or settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const PW = 'Staff-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };
const signup = async (s, email) => (await s.api('/api/auth/signup', { email, name: email.split('@')[0], password: PW })).d.token;

test('owner invites staff; member approves drafts but is blocked from billing/settings; tenants stay isolated', async () => {
  const s = await startServer(MOCK);
  try {
    const O = await signup(s, 'owner@example.com');
    const M = await signup(s, 'nurse@example.com');
    const X = await signup(s, 'other@example.com');
    const E = await signup(s, 'eve@example.com');
    assert.equal((await s.api('/api/clinic/role', { role: 'dental' }, O)).status, 200);
    assert.equal((await s.api('/api/clinic/role', { role: 'dental' }, X)).status, 200);

    // Only the owner invites; members cannot.
    const inv = await s.api('/api/clinic/team/invite', { email: 'nurse@example.com', role: 'member' }, O);
    assert.equal(inv.status, 200, JSON.stringify(inv.d));
    assert.equal(inv.d.invite.sent, false);
    const { token, owner } = inv.d.invite;

    // Wrong account or wrong token cannot accept.
    assert.equal((await s.api('/api/clinic/team/accept', { token, owner }, E)).status, 404);
    assert.equal((await s.api('/api/clinic/team/accept', { token: 'nope', owner }, M)).status, 404);
    const acc = await s.api('/api/clinic/team/accept', { token, owner }, M);
    assert.equal(acc.status, 200, JSON.stringify(acc.d));
    assert.equal(acc.d.role, 'member');
    // Token is single use.
    assert.equal((await s.api('/api/clinic/team/accept', { token, owner }, M)).status, 404);

    // Member sees the owner's clinic.
    const view = await s.api('/api/clinic', undefined, M);
    assert.equal(view.status, 200);
    const ownView = (await s.api('/api/clinic', undefined, O)).d;
    assert.equal(view.d.biz, ownView.biz);

    // Member can approve a pending draft.
    const pending = (ownView.drafts || []).find((d) => d.status === 'pending' && d.approvalId);
    assert.ok(pending, 'seed has a pending draft');
    const dec = await s.api('/api/clinic/decide', { id: pending.approvalId, decision: 'approve' }, M);
    assert.equal(dec.status, 200, JSON.stringify(dec.d));

    // Member is blocked from billing, settings, connectors, export, data delete and team admin.
    for (const [p, b] of [['/api/clinic/plan', { plan: 'pro' }], ['/api/clinic/profile', { biz: 'Hacked' }], ['/api/clinic/role', { role: 'salon' }],
      ['/api/clinic/invoices', { patientId: 1 }], ['/api/clinic/payments/simulate', {}], ['/api/clinic/data/delete', {}],
      ['/api/clinic/connectors/sync', {}], ['/api/clinic/rules', {}], ['/api/clinic/team/invite', { email: 'z@example.com' }], ['/api/clinic/team/remove', { email: 'owner@example.com' }]]) {
      const r = await s.api(p, b, M);
      assert.equal(r.status, 403, p + ' ' + JSON.stringify(r.d));
    }
    assert.equal((await s.api('/api/clinic/export', undefined, M)).status, 403);
    assert.equal((await s.api('/api/clinic', undefined, O)).d.biz, ownView.biz, 'profile unchanged');

    // Raw KV cannot forge membership or the team record.
    const forge = await s.api('/api/kv', { k: 'as_cmember:eve@example.com', v: JSON.stringify('owner@example.com') }, E);
    assert.notEqual(forge.status, 200);
    const forge2 = await fetch(s.base + '/api/kv', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + E }, body: JSON.stringify({ k: 'as_cmember:eve@example.com', v: '"owner@example.com"' }) });
    assert.notEqual(forge2.status, 200);
    // Eve still sees only her own (empty) clinic, never the owner's.
    const ev = (await s.api('/api/clinic', undefined, E)).d;
    assert.ok(ev.needsRole && ev.biz === undefined);

    // Other tenant is untouched by member actions, and member cannot reach it.
    const xv = (await s.api('/api/clinic', undefined, X)).d;
    assert.ok(!(xv.drafts || []).some((d) => d.status === 'approved' && d.approvalId === pending.approvalId));
    const team = await s.api('/api/clinic/team', undefined, X);
    assert.equal(team.d.members.length, 0);

    // Owner removes the member; access falls back to the member's own (empty) account.
    assert.equal((await s.api('/api/clinic/team/remove', { email: 'nurse@example.com' }, O)).status, 200);
    assert.ok((await s.api('/api/clinic', undefined, M)).d.needsRole);
  } finally { await s.stop(); }
});

test('an account that owns a clinic cannot be added to another, and admins cannot change the plan', async () => {
  const s = await startServer(MOCK);
  try {
    const O = await signup(s, 'o2@example.com');
    const A = await signup(s, 'a2@example.com');
    const X = await signup(s, 'x2@example.com');
    await s.api('/api/clinic/role', { role: 'dental' }, O);
    await s.api('/api/clinic/role', { role: 'dental' }, X);
    const ix = (await s.api('/api/clinic/team/invite', { email: 'x2@example.com' }, O)).d.invite;
    assert.equal((await s.api('/api/clinic/team/accept', { token: ix.token, owner: ix.owner }, X)).status, 409);
    const ia = (await s.api('/api/clinic/team/invite', { email: 'a2@example.com', role: 'admin' }, O)).d.invite;
    assert.equal((await s.api('/api/clinic/team/accept', { token: ia.token, owner: ia.owner }, A)).status, 200);
    assert.equal((await s.api('/api/clinic/plan', { plan: 'pro' }, A)).status, 403);
    assert.equal((await s.api('/api/clinic/team/invite', { email: 'q@example.com' }, A)).status, 403);
    assert.equal((await s.api('/api/clinic/profile', { biz: 'Admin Edit' }, A)).status, 200);
  } finally { await s.stop(); }
});
