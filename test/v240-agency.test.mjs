// v2.4 agency white-label. No payments. Client mail leaves only from that client's own Gmail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { fakeSMTP } from './mocks.mjs';

const PW = 'Agency-pass-123!';
const CLIENT_PW = 'Client-pass-123!';
const STAFF_PW = 'Staff-pass-123!';
const CRON = 'c'.repeat(32);

async function req(s, method, p, body, token, extra = {}) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = text; }
  return { status: r.status, d, text, headers: r.headers };
}
const login = (s, email, password) => req(s, 'POST', '/api/auth/login', { email, password });

test('agency workspaces stay isolated, branded, capped, and unpaid', async () => {
  const smtp = await fakeSMTP();
  const s = await startServer({
    RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on',
    CRON_SECRET: CRON, ADMIN_EMAIL: 'platform-admin@example.com', ADMIN_PASSWORD: PW,
    GMAIL_USER: 'platform@example.com', GMAIL_APP_PASSWORD: 'test-app-password',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_IGNORE_TLS: 'true',
  });
  try {
    const ownerSignup = await req(s, 'POST', '/api/auth/signup', { email: 'owner-a@example.com', name: 'North Owner', password: PW });
    assert.equal(ownerSignup.status, 200, JSON.stringify(ownerSignup.d));
    const owner = ownerSignup.d.token;
    const other = (await req(s, 'POST', '/api/auth/signup', { email: 'owner-b@example.com', name: 'Other Owner', password: PW })).d.token;
    const plain = (await req(s, 'POST', '/api/auth/signup', { email: 'plain@example.com', name: 'Plain Customer', password: PW })).d.token;
    const platform = (await login(s, 'platform-admin@example.com', PW)).d.token;
    assert.ok(platform, 'platform admin login');

    assert.equal((await req(s, 'GET', '/api/agency', undefined, plain)).status, 403);
    assert.equal((await req(s, 'POST', '/api/agency', { name: 'Platform Agency' }, platform)).status, 403);
    const made = await req(s, 'POST', '/api/agency', { name: 'North Desk' }, owner);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    assert.equal(made.d.created, true);
    assert.equal(made.d.mailed, false);
    assert.equal(made.d.payment, false);
    assert.equal((await req(s, 'POST', '/api/agency', { name: 'Other Desk' }, other)).status, 200);
    const mailsAfterAgency = smtp.mails.length;

    const badLogo = await req(s, 'POST', '/api/agency/branding', { logo: 'data:image/svg+xml;base64,PHN2Zy8+' }, owner);
    assert.equal(badLogo.status, 400);
    const badHost = await req(s, 'POST', '/api/agency/branding', { domain: 'https://app.north.example/login' }, owner);
    assert.equal(badHost.d.branding ? badHost.d.branding.domain : '', 'app.north.example');
    const brand = await req(s, 'POST', '/api/agency/branding', {
      name: 'North Desk', logo: 'https://cdn.example.com/logo.png', color: '#1F6B4A', accent: '#0b3d2e',
      support_email: 'help@north.example', domain: 'app.north.example',
    }, owner);
    assert.equal(brand.status, 200, JSON.stringify(brand.d));
    assert.equal(brand.d.branding.color, '#1f6b4a');
    assert.equal(brand.d.dns.payment, 'Nothing here takes a payment.');
    assert.match(brand.d.dns.mail, /Gmail that client has connected/);
    assert.equal((await req(s, 'POST', '/api/agency/branding', { domain: 'app.north.example' }, other)).status, 409);
    const pub = await req(s, 'GET', '/api/branding?host=app.north.example');
    assert.equal(pub.d.name, 'North Desk');
    assert.equal(pub.d.color, '#1f6b4a');
    assert.equal(pub.d.support_email, 'help@north.example');
    assert.equal((await req(s, 'GET', '/api/branding?host=app.other.example')).d.source, 'platform');

    const client = await req(s, 'POST', '/api/agency/clients', { email: 'client-a@example.com', name: '=1+1', password: CLIENT_PW }, owner);
    assert.equal(client.status, 200, JSON.stringify(client.d));
    assert.equal(client.d.mailed, false);
    assert.equal(client.d.payment, false);
    assert.doesNotMatch(JSON.stringify(client.d), new RegExp(CLIENT_PW));
    assert.equal(smtp.mails.length, mailsAfterAgency);
    const clientB = await req(s, 'POST', '/api/agency/clients', { email: 'client-b@example.com', name: 'Sibling', password: CLIENT_PW }, owner);
    assert.equal(clientB.status, 200);
    const clientTok = (await login(s, 'client-a@example.com', CLIENT_PW)).d.token;
    const sibTok = (await login(s, 'client-b@example.com', CLIENT_PW)).d.token;
    assert.equal((await req(s, 'POST', '/api/agency', { name: 'Nope' }, clientTok)).status, 403);
    const me = await req(s, 'GET', '/api/auth/me', undefined, clientTok);
    assert.equal(me.d.user.brand.name, 'North Desk');
    assert.equal(me.d.user.kind, 'client');
    assert.equal(me.d.user.hash, undefined);

    const member = await req(s, 'POST', '/api/agency/staff', { email: 'member-a@example.com', name: 'Mina Member', password: STAFF_PW, role: 'member' }, owner);
    assert.equal(member.status, 200, JSON.stringify(member.d));
    assert.equal(member.d.mailed, false);
    const admin = await req(s, 'POST', '/api/agency/staff', { email: 'admin-a@example.com', name: 'Ari Admin', password: STAFF_PW, role: 'admin' }, owner);
    assert.equal(admin.status, 200);
    const memberTok = (await login(s, 'member-a@example.com', STAFF_PW)).d.token;
    const adminTok = (await login(s, 'admin-a@example.com', STAFF_PW)).d.token;
    assert.equal((await req(s, 'POST', '/api/agency/staff', { email: 'extra-admin@example.com', name: 'Nope', password: STAFF_PW, role: 'admin' }, adminTok)).status, 403);
    assert.equal((await req(s, 'POST', '/api/agency/branding', { name: 'Hijack' }, adminTok)).status, 403);
    assert.equal((await req(s, 'POST', '/api/agency/markup', { percent: 10 }, adminTok)).status, 403);
    const memberView = await req(s, 'GET', '/api/agency', undefined, memberTok);
    assert.equal(memberView.status, 200);
    assert.equal(memberView.d.agency.markup, undefined);
    assert.equal((await req(s, 'POST', '/api/agency/clients', { email: 'nope@example.com', name: 'Nope', password: CLIENT_PW }, memberTok)).status, 403);
    assert.equal((await req(s, 'GET', '/api/agency/invoice', undefined, memberTok)).status, 403);
    assert.equal((await req(s, 'GET', '/api/agency/dns', undefined, memberTok)).status, 200);
    const beforeAudit = (await req(s, 'GET', '/api/agency/audit', undefined, owner)).d.audit.map((a) => a.action);
    const memberAs = await req(s, 'POST', '/api/agency/view-as', { email: 'client-a@example.com' }, memberTok);
    assert.equal(memberAs.status, 403);
    const afterAudit = (await req(s, 'GET', '/api/agency/audit', undefined, owner)).d.audit.map((a) => a.action);
    assert.equal(afterAudit.filter((a) => a === 'view_as').length, beforeAudit.filter((a) => a === 'view_as').length);

    const addedByAdmin = await req(s, 'POST', '/api/agency/clients', { email: 'client-c@example.com', name: 'Added By Admin', password: CLIENT_PW }, adminTok);
    assert.equal(addedByAdmin.status, 200);
    assert.equal(addedByAdmin.d.mailed, false);

    assert.equal((await req(s, 'GET', '/api/agency/clients/usage?email=client-a@example.com', undefined, other)).status, 404);
    assert.equal((await req(s, 'POST', '/api/agency/view-as', { email: 'client-a@example.com' }, other)).status, 404);
    assert.equal((await req(s, 'POST', '/api/agency/playbook', { email: 'client-a@example.com', id: 'pb_agency', confirm: true }, other)).status, 404);
    const otherHome = await req(s, 'GET', '/api/agency', undefined, other);
    assert.equal(otherHome.d.clients.length, 0);
    assert.doesNotMatch(JSON.stringify(otherHome.d), /client-a@example.com|Client-pass|North Desk/);

    const secret = await req(s, 'PUT', '/api/kv', { k: 'as_data:client-a@example.com', v: JSON.stringify({ rev: 0, agents: [{ id: 1, name: 'Notes', kind: 'research', kb: [{ title: 'Secret', text: 'CLIENT-A-ONLY-SECRET' }] }] }) }, clientTok);
    assert.equal(secret.status, 200, JSON.stringify(secret.d));
    const sibKv = await req(s, 'GET', '/api/kv', undefined, sibTok);
    assert.doesNotMatch(JSON.stringify(sibKv.d), /CLIENT-A-ONLY-SECRET|client-a@example.com|Client-pass/);
    for (const k of ['as_ag:owner-a@example.com', 'as_aguse:client-a@example.com', 'as_agaudit:owner-a@example.com', 'as_agdom:app.north.example'])
      assert.equal((await req(s, 'PUT', '/api/kv', { k, v: '{}' }, sibTok)).status, 400, k);

    const preview = await req(s, 'POST', '/api/agency/playbook', { email: 'client-a@example.com', id: 'pb_agency', confirm: 'true' }, owner);
    assert.equal(preview.status, 200, JSON.stringify(preview.d));
    assert.equal(preview.d.installed, false);
    assert.equal(preview.d.sent, false);
    assert.equal((await req(s, 'GET', '/api/workflows', undefined, clientTok)).d.workflows.length, 0);
    const installed = await req(s, 'POST', '/api/agency/playbook', { email: 'client-a@example.com', id: 'pb_agency', confirm: true }, owner);
    assert.equal(installed.status, 200, JSON.stringify(installed.d));
    assert.equal(installed.d.installed, true);
    assert.equal(installed.d.sent, false);
    assert.ok(installed.d.result.workflows.length > 0);
    for (const w of installed.d.result.workflows) assert.equal(w.status, 'draft');
    const wfs = (await req(s, 'GET', '/api/workflows', undefined, clientTok)).d.workflows;
    assert.ok(wfs.length > 0);
    assert.equal(wfs.every((w) => w.status === 'draft'), true);

    const ai1 = await req(s, 'POST', '/api/ai', { prompt: 'Say hello in three words', use_profile: false }, clientTok);
    assert.equal(ai1.status, 200, JSON.stringify(ai1.d));
    const used = (await req(s, 'GET', '/api/agency/clients/usage?email=client-a@example.com', undefined, owner)).d.usage;
    assert.ok(used.ai_calls >= 1);
    assert.equal((await req(s, 'POST', '/api/agency/clients/update', { email: 'client-a@example.com', limits: { ai_calls: used.ai_calls, leads: 1, messages: 0 } }, owner)).status, 200);
    const ai2 = await req(s, 'POST', '/api/ai', { prompt: 'Say hello again', use_profile: false }, clientTok);
    assert.equal(ai2.status, 429);
    assert.equal(ai2.d.error, 'client_limit');
    const lead1 = await req(s, 'POST', '/api/leads', { name: 'Only A', email: 'onlya@secret.example' }, clientTok);
    assert.equal(lead1.status, 200, JSON.stringify(lead1.d));
    const lead2 = await req(s, 'POST', '/api/leads', { name: 'Second', email: 'second@secret.example' }, clientTok);
    assert.equal(lead2.status, 402);
    assert.equal(lead2.d.error, 'client_limit');
    assert.equal((await req(s, 'GET', '/api/leads', undefined, sibTok)).d.leads.length, 0);
    const csv = 'name,email\nImported One,imp1@secret.example\nImported Two,imp2@secret.example\n';
    const imported = await req(s, 'POST', '/api/leads/import', { csv, dry_run: false }, clientTok);
    assert.equal(imported.d.created, 0);
    assert.ok(imported.d.errors.length >= 1);
    const inbound = await req(s, 'POST', '/api/channels/email/mock', { from: 'inbound@secret.example', name: 'Inbound', body: 'hello there', subject: 'Hi' }, clientTok);
    assert.equal(inbound.status, 200, JSON.stringify(inbound.d));
    const names = (await req(s, 'GET', '/api/leads', undefined, clientTok)).d.leads.map((l) => l.email);
    assert.equal(names.includes('inbound@secret.example'), false);
    assert.equal(names.includes('onlya@secret.example'), true);
    const stopped = await req(s, 'POST', '/api/channels/email/mock', { from: 'stop@secret.example', name: 'Stop Person', body: 'STOP', subject: 'Stop' }, clientTok);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.d));
    const afterStop = (await req(s, 'GET', '/api/leads', undefined, clientTok)).d.leads.map((l) => l.email);
    assert.equal(afterStop.includes('stop@secret.example'), true);
    const send = await req(s, 'POST', '/api/channels/send', { channel: 'webchat', to: 'visitorlimit1', body: 'hi there', confirm: true }, clientTok);
    assert.equal(send.status, 402);
    assert.equal(send.d.error, 'client_limit');
    const usage = (await req(s, 'GET', '/api/agency/clients/usage?email=client-a@example.com', undefined, owner)).d;
    assert.equal(usage.usage.messages, 0);
    assert.doesNotMatch(JSON.stringify(usage), new RegExp(CLIENT_PW + '|hash'));

    assert.equal((await req(s, 'POST', '/api/agency/markup', { percent: 25, message_inr: 2, lead_inr: 3 }, owner)).status, 200);
    const month = usage.usage.month;
    const inv = await req(s, 'GET', '/api/agency/invoice?month=' + month, undefined, owner);
    assert.equal(inv.status, 200, JSON.stringify(inv.d));
    assert.equal(inv.d.payment, false);
    assert.match(inv.d.note, /No payment/);
    const line = inv.d.lines.find((l) => l.email === 'client-a@example.com');
    assert.ok(line);
    assert.equal(line.lead_billed_inr > 0, true);
    assert.equal(inv.d.lines.some((l) => l.email === 'client-a@example.com' && l.ai_billed_usd != null), true);
    assert.doesNotMatch(JSON.stringify(inv.d), /razorpay|Client-pass/i);
    const csvRes = await fetch(s.base + '/api/agency/invoice.csv?month=' + month, { headers: { authorization: 'Bearer ' + owner } });
    const csvBody = await csvRes.text();
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-disposition') || '', /usage-/);
    assert.match(csvBody, /'=1\+1|client-a@example.com/);
    assert.match(csvBody, /No payment is taken/);
    assert.doesNotMatch(csvBody, /Client-pass|razorpay/i);
    const htmlRes = await fetch(s.base + '/api/agency/invoice.html?month=' + month, { headers: { authorization: 'Bearer ' + owner } });
    const html = await htmlRes.text();
    assert.match(html, /does not take payment/);
    assert.match(html, /#1f6b4a/);
    assert.doesNotMatch(html, /razorpay/i);
    const otherInv = await req(s, 'GET', '/api/agency/invoice?month=' + month, undefined, other);
    assert.equal(otherInv.d.lines.some((l) => /client-a|onlya/.test(l.email)), false);

    const suspended = await req(s, 'POST', '/api/agency/clients/update', { email: 'client-b@example.com', suspended: true }, owner);
    assert.equal(suspended.status, 200);
    assert.equal((await req(s, 'POST', '/api/agency/view-as', { email: 'client-b@example.com' }, owner)).status, 403);
    const view = await req(s, 'POST', '/api/agency/view-as', { email: 'client-a@example.com' }, owner);
    assert.equal(view.status, 200, JSON.stringify(view.d));
    assert.equal(view.d.read_only, true);
    assert.ok(view.d.audit_id);
    const claims = JSON.parse(Buffer.from(view.d.token.split('.')[0], 'base64url').toString());
    assert.equal(claims.imp, 1);
    assert.ok(claims.x - Date.now() < 3 * 3600e3);
    assert.ok(claims.x - Date.now() > 3600e3);
    const asLeads = await req(s, 'GET', '/api/leads', undefined, view.d.token);
    assert.equal(asLeads.status, 200);
    assert.equal(asLeads.d.leads.some((l) => l.email === 'onlya@secret.example'), true);
    assert.equal((await req(s, 'POST', '/api/leads', { name: 'Nope', email: 'nope-view@secret.example' }, view.d.token)).status, 403);
    assert.equal((await req(s, 'GET', '/api/ai/key', undefined, view.d.token)).status, 403);
    assert.equal((await req(s, 'GET', '/api/connectors', undefined, view.d.token)).status, 403);
    assert.equal((await req(s, 'GET', '/api/settings', undefined, view.d.token)).status, 403);
    assert.equal((await req(s, 'GET', '/api/agency', undefined, view.d.token)).status, 403);
    const audit = await req(s, 'GET', '/api/agency/audit', undefined, adminTok);
    assert.equal(audit.d.audit.some((a) => a.action === 'view_as' && a.client === 'client-a@example.com' && a.actor === 'owner-a@example.com'), true);
    assert.doesNotMatch(JSON.stringify(audit.d), new RegExp(CLIENT_PW + '|CLIENT-A-ONLY-SECRET'));

    const widget = await req(s, 'POST', '/api/frontdesk/widget', {}, clientTok);
    assert.equal(widget.status, 200, JSON.stringify(widget.d));
    const script = await (await fetch(s.base + '/c/' + widget.d.widget.token + '.js')).text();
    assert.equal(script.includes(widget.d.widget.token), true);
    assert.match(script, /North Desk/);
    assert.match(script, /#1f6b4a/);
    const page = await (await fetch(s.base + '/c/' + widget.d.widget.token)).text();
    assert.match(page, /North Desk/);

    const code = await req(s, 'POST', '/api/auth/email/start', { email: 'client-a@example.com' });
    assert.equal(code.status, 200, JSON.stringify(code.d));
    assert.equal(code.d.via, 'mail');
    const codeMail = smtp.mails[smtp.mails.length - 1];
    assert.match(codeMail.data, /North Desk/);
    assert.match(codeMail.data, /platform@example.com/);
    assert.doesNotMatch(codeMail.from || '', /client-a@example.com/);

    await req(s, 'POST', '/api/agency/clients/update', { email: 'client-a@example.com', limits: { ai_calls: null, leads: null, messages: null } }, owner);
    const compiled = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send them an email' }, clientTok);
    assert.equal(compiled.status, 200, JSON.stringify(compiled.d));
    const wf = compiled.d.workflow;
    const step = wf.steps.find((x) => x.type === 'send_email');
    assert.ok(step);
    assert.equal(step.autonomy, 'needs_approval');
    await req(s, 'POST', '/api/workflows/update', { id: wf.id, step: { id: step.id, autonomy: 'auto', subject: 'Hello from the desk', body: 'Hi from the client mailbox' }, status: 'enabled' }, clientTok);
    const beforeSend = smtp.mails.length;
    const quietLead = await req(s, 'POST', '/api/leads', { name: 'Quiet', email: 'quiet@secret.example' }, clientTok);
    assert.equal(quietLead.status, 200, JSON.stringify(quietLead.d));
    const quietTick = await req(s, 'GET', '/api/cron/tick', undefined, undefined, { headers: { authorization: 'Bearer ' + CRON } });
    assert.equal(quietTick.status, 200, JSON.stringify(quietTick.d));
    assert.equal(smtp.mails.length, beforeSend);
    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, clientTok)).d.items || [];
    assert.ok(pending.some((a) => /quiet@secret.example|Hello from the desk/.test(JSON.stringify(a))));

    const connected = await req(s, 'POST', '/api/connectors/key', { c: 'gmail', fields: { user: 'clientbox@example.com', pass: 'app-password-client' } }, clientTok);
    assert.equal(connected.status, 200, JSON.stringify(connected.d));
    const liveLead = await req(s, 'POST', '/api/leads', { name: 'Live', email: 'live@secret.example' }, clientTok);
    assert.equal(liveLead.status, 200, JSON.stringify(liveLead.d));
    const liveTick = await req(s, 'GET', '/api/cron/tick', undefined, undefined, { headers: { authorization: 'Bearer ' + CRON, 'x-test-now': String(Date.now() + 1000) } });
    assert.equal(liveTick.status, 200, JSON.stringify(liveTick.d));
    const sent = smtp.mails.slice(beforeSend).find((m) => /live@secret.example/.test(m.data + (m.to || []).join(',')));
    assert.ok(sent, 'client mailbox should have sent');
    assert.match(sent.data, /North Desk/);
    assert.match(sent.data, /clientbox@example.com/);
    assert.doesNotMatch(sent.data, /From:.*platform@example.com/);

    assert.equal((await req(s, 'POST', '/api/auth/delete', { password: PW }, owner)).status, 409);
    assert.equal((await req(s, 'POST', '/api/auth/remove', { email: 'owner-a@example.com' }, platform)).status, 409);
    const home = await req(s, 'GET', '/api/agency', undefined, owner);
    assert.equal(home.d.payment, false);
    assert.doesNotMatch(JSON.stringify(home.d), new RegExp(CLIENT_PW + '|' + STAFF_PW + '|CLIENT-A-ONLY-SECRET|app-password-client'));
  } finally { await s.stop(); await smtp.close(); }
});
