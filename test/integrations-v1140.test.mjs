// v1.14: connection health (Gmail), approvals edit/batch/history/clear, flexible CRM (fields, stages, tags, CSV). All per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { fakeSMTP } from './mocks.mjs';
import { parseCsv, cleanFieldDefs } from '../lib/leads.js';

const PW = 'Integr-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };
const req = async (s, method, p, body, token) => {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let d = null; try { d = JSON.parse(txt); } catch { d = txt; }
  return { status: r.status, d, h: r.headers };
};
const two = async (s) => [(await s.api('/api/auth/signup', { email: 'ia@example.com', name: 'IA', password: PW })).d.token, (await s.api('/api/auth/signup', { email: 'ib@example.com', name: 'IB', password: PW })).d.token];

test('csv parser and field definitions', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  assert.throws(() => cleanFieldDefs([{ label: 'Email' }]), /built-in/);
  assert.throws(() => cleanFieldDefs([{ label: 'Plan', type: 'select' }]), /option/);
  assert.deepEqual(cleanFieldDefs([{ label: 'Monthly budget', type: 'number' }])[0], { key: 'monthly_budget', label: 'Monthly budget', type: 'number' });
});

test('Gmail connect, check, error + reconnect, disconnect: per account', async () => {
  const smtp = await fakeSMTP();
  const s = await startServer({ ...MOCK, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_IGNORE_TLS: 'true' });
  try {
    const [A, B] = await two(s);
    assert.equal((await s.api('/api/connectors/key', { c: 'gmail', fields: { user: 'me@agency.test', pass: 'abcd abcd abcd abcd' } }, A)).status, 200);
    let it = (await s.api('/api/connectors', undefined, A)).d.items.find((x) => x.id === 'gmail');
    assert.equal(it.status, 'connected'); assert.equal(it.via, 'smtp'); assert.equal(it.acct, 'me@agency.test');
    assert.equal((await s.api('/api/connectors/check', { c: 'gmail' }, A)).d.status, 'connected');
    assert.equal((await s.api('/api/connectors', undefined, B)).d.items.length, 0, 'B sees none of A\'s connections');
    assert.equal((await s.api('/api/connectors/check', { c: 'gmail' }, B)).status, 404);
    assert.equal((await s.api('/api/connectors/disconnect', { c: 'gmail' }, B)).d.was, false);
    await smtp.close(); // Gmail "goes away": the check reports an error and asks to reconnect
    const bad = (await s.api('/api/connectors/check', { c: 'gmail' }, A)).d;
    assert.equal(bad.status, 'error'); assert.equal(bad.reconnect, true); assert.match(bad.error, /reach|refused/i);
    it = (await s.api('/api/connectors', undefined, A)).d.items.find((x) => x.id === 'gmail'); assert.equal(it.status, 'error');
    assert.equal((await s.api('/api/connectors/disconnect', { c: 'gmail' }, A)).d.was, true);
    assert.equal((await s.api('/api/connectors', undefined, A)).d.items.length, 0);
  } finally { await s.stop(); }
});

test('approvals: edit then approve, reject with note, batch, history, clear; never across accounts', async () => {
  const s = await startServer(MOCK);
  try {
    const [A, B] = await two(s);
    const mk = async (n) => (await s.api('/api/workplace/chat', { message: 'draft [[mock:propose_action {"app":"draft","summary":"Post ' + n + '","request":"Text ' + n + '"}]]' }, A)).d.approvals[0];
    const a1 = await mk(1), a2 = await mk(2), a3 = await mk(3), a4 = await mk(4);
    let h = (await s.api('/api/agents/approvals', undefined, A)).d; assert.equal(h.pending, 4);
    assert.equal((await s.api('/api/agents/approvals', undefined, B)).d.total, 0);
    assert.equal((await s.api('/api/agents/approval/edit', { id: a1.id, request: 'hacked' }, B)).status, 404);
    const ed = (await s.api('/api/agents/approval/edit', { id: a1.id, request: 'Better text 1' }, A)).d;
    assert.deepEqual(ed.changed, ['request']); assert.equal(ed.approval.edited, true);
    const ok = (await s.api('/api/agents/approval', { id: a2.id, decision: 'approve', edit: { request: 'Edited inline 2' } }, A)).d;
    assert.equal(ok.approval.status, 'done'); assert.match(ok.approval.result, /Nothing was sent/);
    assert.equal((await s.api('/api/agents/approval/edit', { id: a2.id, request: 'x' }, A)).status, 409, 'decided items cannot be edited');
    const rj = (await s.api('/api/agents/approval', { id: a3.id, decision: 'reject', note: 'Wrong tone' }, A)).d;
    assert.equal(rj.approval.status, 'declined'); assert.equal(rj.approval.note, 'Wrong tone');
    const bb = (await s.api('/api/agents/approvals/batch', { ids: [a1.id, a4.id], decision: 'approve' }, B)).d;
    assert.ok(bb.results.every((r) => r.error === 'not_found'), 'B cannot batch-approve A\'s items');
    const ba = (await s.api('/api/agents/approvals/batch', { ids: [a1.id, a4.id], decision: 'approve' }, A)).d;
    assert.deepEqual(ba.results.map((r) => r.status), ['done', 'done']);
    assert.equal((await s.api('/api/agents/approvals/batch', { ids: [], decision: 'approve' }, A)).status, 400);
    h = (await s.api('/api/agents/approvals', undefined, A)).d;
    assert.equal(h.pending, 0); assert.equal(h.items.find((x) => x.id === a1.id).request, 'Better text 1');
    assert.equal((await s.api('/api/agents/approvals?status=declined', undefined, A)).d.total, 1);
    assert.equal((await s.api('/api/agents/approvals/clear', {}, B)).d.cleared, 0);
    assert.equal((await s.api('/api/agents/approvals/clear', {}, A)).d.cleared, 4);
    assert.equal((await s.api('/api/agents/approvals', undefined, A)).d.total, 0);
  } finally { await s.stop(); }
});

test('CRM: custom fields, stages, tags, CSV import/export; per account', async () => {
  const s = await startServer(MOCK);
  try {
    const [A, B] = await two(s);
    assert.deepEqual((await s.api('/api/leads/stages', undefined, A)).d.stages, ['New lead', 'Contacted', 'Proposal sent', 'Won', 'Lost']);
    assert.equal((await req(s, 'PUT', '/api/leads/fields', { fields: [{ label: 'Monthly budget', type: 'number' }, { label: 'Plan', type: 'select', options: 'Starter, Growth' }, { label: 'Clients', type: 'number' }] }, A)).status, 200);
    assert.equal((await req(s, 'PUT', '/api/leads/stages', { stages: ['Inbound', 'Call booked', 'Won'] }, A)).status, 200);
    assert.equal((await s.api('/api/leads/fields', undefined, B)).d.fields.length, 0, 'B has its own (empty) field list');
    const l = (await s.api('/api/leads', { name: 'Asha Rao', email: 'asha@agency.in', stage: 'call booked', fields: { monthly_budget: '50,000', Plan: 'growth' }, tags: 'agency' }, A)).d.lead;
    assert.equal(l.stage, 'Call booked'); assert.deepEqual(l.fields, { monthly_budget: 50000, plan: 'Growth' });
    assert.equal((await s.api('/api/leads', { name: 'X', email: 'x@y.co', stage: 'Nope' }, A)).status, 400);
    assert.equal((await s.api('/api/leads', { name: 'X', email: 'x@y.co', fields: { unknown: 1 } }, A)).status, 400);
    assert.equal((await s.api('/api/leads', { name: 'X', email: 'x@y.co', fields: { plan: 'Gold' } }, A)).status, 400);
    const p = (await req(s, 'PATCH', '/api/leads/' + l.id, { stage: 'Won', fields: { clients: 12 } }, A)).d.lead;
    assert.equal(p.stage, 'Won'); assert.equal(p.fields.clients, 12); assert.equal(p.fields.plan, 'Growth');
    // import
    const csv = 'Name,Email,Phone,Tags,Stage,Monthly budget,Plan\n"Ravi K",ravi@x.in,,"email;agency",Inbound,"1,20,000",Starter\nNo Contact,,,,,,\n"Asha Rao",asha@agency.in,,,,,\n=cmd,evil@x.in,,,,,\nBad Plan,bp@x.in,,,,,Gold\n';
    const dry = (await s.api('/api/leads/import', { csv, dry_run: true }, A)).d;
    assert.equal(dry.created, 2); assert.equal(dry.skipped, 1); assert.equal(dry.errors.length, 2);
    assert.equal((await s.api('/api/leads', undefined, A)).d.total, 1, 'dry run writes nothing');
    const im = (await s.api('/api/leads/import', { csv }, A)).d; assert.equal(im.created, 2);
    const ravi = (await s.api('/api/leads?q=ravi', undefined, A)).d.leads[0];
    assert.equal(ravi.fields.monthly_budget, 120000); assert.deepEqual(ravi.tags, ['email', 'agency']);
    assert.equal((await s.api('/api/leads?tag=agency', undefined, A)).d.total, 2);
    assert.equal((await s.api('/api/leads?stage=inbound', undefined, A)).d.total, 2);
    // bulk tags
    assert.equal((await s.api('/api/leads/tags', { ids: [l.id, ravi.id], add: 'vip', remove: 'agency' }, A)).d.updated, 2);
    assert.equal((await s.api('/api/leads/tags', { ids: [l.id], add: 'pwned' }, B)).d.updated, 0);
    assert.equal((await s.api('/api/leads?tag=vip', undefined, A)).d.total, 2);
    // export
    const ex = await req(s, 'GET', '/api/leads/export.csv', undefined, A);
    assert.equal(ex.status, 200); assert.match(ex.h.get('content-type'), /text\/csv/); assert.match(ex.h.get('content-disposition') || '', /leads\.csv/);
    const rows = parseCsv(ex.d);
    assert.ok(rows[0].includes('Monthly budget')); assert.equal(rows.length, 4);
    assert.ok(rows.some((r) => r.includes("'=cmd")), 'formula cells are made safe');
    assert.equal(parseCsv((await req(s, 'GET', '/api/leads/export.csv', undefined, B)).d).length, 1, 'B exports only its own (empty) list');
    // removing a stage moves its leads
    const mv = (await req(s, 'PUT', '/api/leads/stages', { stages: ['Inbound', 'Won'] }, A)).d; assert.equal(mv.moved, 0);
    const mv2 = (await req(s, 'PUT', '/api/leads/stages', { stages: ['Won'] }, A)).d; assert.equal(mv2.moved, 2);
    assert.ok((await req(s, 'GET', '/api/leads/' + ravi.id, undefined, A)).d.lead.hist.some((x) => /stage removed/.test(x.t)));
  } finally { await s.stop(); }
});
