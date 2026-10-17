// End-to-end flows against a real server with mocked outside services (no real AI spend, nothing really sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { mockLLM, mockBuffer, fakeSMTP } from './mocks.mjs';

const OWNER = 'owner@agency.test', PW = 'Correct-Horse-42!';
const AGENTS = [
  { id: 1, name: 'Social Manager', kind: 'custom', d: 'Writes and schedules social posts.', status: 'active', group: 'Marketing' },
  { id: 2, name: 'Copywriter', kind: 'custom', d: 'Writes email and ad copy.', status: 'active', group: 'Marketing' },
  { id: 3, name: 'Analyst', kind: 'custom', d: 'Reports on campaign numbers.', status: 'active', group: 'Marketing' },
];
const PLAN = { tasks: [
  { title: 'Draft launch copy', body: 'Three subject lines', assignee_id: 2, after: null, research: false },
  { title: 'Schedule posts', body: 'LinkedIn + X', assignee_id: 1, after: 0, research: false },
  { title: 'Report results', body: 'Open rates', assignee_id: 3, after: 1, research: false },
  { title: 'Unknown member', body: 'Should fall back to the lead', assignee_id: 99, after: 2, research: false },
] };

function script(r) {
  if (/Reply with JSON only/.test(r.user + r.system)) return { text: JSON.stringify(PLAN) };
  if (/^You are Copywriter/.test(r.system)) return { text: 'COPY FROM COPYWRITER' };
  const once = (tool) => (r.lastIsTool ? { text: 'Done, waiting for approval.' } : { tool });
  if (r.user.includes('[[post]]')) return once({ name: 'social_post', args: { text: 'New guide for email marketers is live.', channels: 'all', when: 'queue' } });
  if (r.user.includes('[[email]]')) return once({ name: 'send_email', args: { to: 'client@example.com', subject: 'Campaign recap', body: 'Here is the recap.' } });
  if (r.user.includes('[[delegate]]') && r.tools.includes('ask_agent')) return r.lastIsTool ? { text: 'Copywriter answered.' } : { tool: { name: 'ask_agent', args: { agent_id: 2, task: 'Write a subject line' } } };
  return { text: 'OK.' };
}

let llm, buf, smtp, srv, token;
test.before(async () => {
  [llm, buf, smtp] = await Promise.all([mockLLM(script), mockBuffer(), fakeSMTP()]);
  srv = await startServer({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: llm.url, OLLAMA_MODEL: 'mock', BUFFER_API_URL: buf.url,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_IGNORE_TLS: 'true' },
  { seed: { ['as_data:' + OWNER]: { rev: 1, agents: AGENTS } } });
});
test.after(async () => { await srv?.stop(); await Promise.all([llm?.close(), buf?.close(), smtp?.close()]); });

test('sign-up and login', async () => {
  const weak = await srv.api('/api/auth/signup', { email: OWNER, name: 'Owner', password: 'password1' });
  assert.equal(weak.status, 400);
  const s = await srv.api('/api/auth/signup', { email: OWNER, name: 'Owner', password: PW });
  assert.equal(s.status, 200); assert.ok(s.d.token);
  assert.equal((await srv.api('/api/auth/signup', { email: OWNER, name: 'Owner', password: PW })).status, 409);
  assert.equal((await srv.api('/api/auth/login', { email: OWNER, password: 'wrong-password-1' })).status, 401);
  const l = await srv.api('/api/auth/login', { email: OWNER, password: PW });
  assert.equal(l.status, 200); token = l.d.token;
  const me = await srv.api('/api/auth/me', undefined, token);
  assert.equal(me.status, 200); assert.equal(me.d.user.email, OWNER);
});

test('connectors: saved credential is encrypted and masked; mocked Buffer call', async () => {
  const bad = await srv.api('/api/connectors/key', { c: 'buffer', fields: { key: 'wrong' } }, token);
  assert.notEqual(bad.status, 200);
  const r = await srv.api('/api/connectors/key', { c: 'buffer', fields: { key: buf.key } }, token);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(buf.seen.some((x) => x.auth === 'Bearer ' + buf.key && x.q.includes('GetOrganizations')), 'Buffer was called with the key');
  const list = await srv.api('/api/connectors', undefined, token);
  assert.ok(!JSON.stringify(list.d).includes(buf.key), 'the key never comes back');
  const fs = await import('node:fs'); const path = await import('node:path');
  await new Promise((x) => setTimeout(x, 300));
  const raw = fs.readFileSync(path.join(srv.dir, 'data', 'kv.json'), 'utf8');
  assert.ok(raw.includes('as_conn:' + OWNER)); assert.ok(!raw.includes(buf.key), 'stored sealed, not in plain text');
  const g = await srv.api('/api/connectors/key', { c: 'gmail', fields: { user: 'sender@agency.test', pass: 'abcdabcdabcdabcd' } }, token);
  assert.equal(g.status, 200, JSON.stringify(g.d));
});

const chat = (message, agent_id = 1) => srv.api('/api/workplace/chat', { message, ...(agent_id == null ? {} : { agent_id }) }, token);
const pending = async (aid) => (await srv.api('/api/agents/state?aid=' + aid, undefined, token)).d.approvals;

test('approval-first: social post waits; reject stops; approve posts', async () => {
  const c1 = await chat('[[post]] share the guide');
  assert.equal(c1.status, 200, JSON.stringify(c1.d));
  assert.equal(c1.d.approvals.length, 1); assert.equal(buf.posts.length, 0, 'nothing posted before approval');
  const a1 = c1.d.approvals[0];
  const rej = await srv.api('/api/agents/approval', { id: a1.id, decision: 'reject' }, token);
  assert.equal(rej.d.approval.status, 'declined'); assert.equal(buf.posts.length, 0);
  assert.equal((await srv.api('/api/agents/approval', { id: a1.id, decision: 'approve' }, token)).d.approval.status, 'declined', 'a rejected item cannot be approved later');
  const c2 = await chat('[[post]] share it again');
  const a2 = c2.d.approvals[0];
  assert.ok((await pending(1)).some((x) => x.id === a2.id));
  const ok = await srv.api('/api/agents/approval', { id: a2.id, decision: 'approve' }, token);
  assert.equal(ok.d.approval.status, 'done', JSON.stringify(ok.d));
  assert.equal(buf.posts.length, 2, 'one post per connected channel');
  assert.deepEqual(buf.posts.map((p) => p.channelId).sort(), ['ch_li', 'ch_x']);
});

test('approval-first: email waits; reject stops; approve sends', async () => {
  const c1 = await chat('[[email]] send the recap');
  const a1 = c1.d.approvals[0]; assert.equal(a1.kind, 'email'); assert.equal(smtp.mails.length, 0);
  await srv.api('/api/agents/approval', { id: a1.id, decision: 'reject' }, token); assert.equal(smtp.mails.length, 0);
  const a2 = (await chat('[[email]] send it now')).d.approvals[0];
  const ok = await srv.api('/api/agents/approval', { id: a2.id, decision: 'approve' }, token);
  assert.equal(ok.d.approval.status, 'done', JSON.stringify(ok.d));
  assert.equal(smtp.mails.length, 1); assert.deepEqual(smtp.mails[0].to, ['client@example.com']);
  assert.match(smtp.mails[0].data, /Campaign recap/);
});

test('Chief of Staff delegates to the right agent (mocked LLM)', async () => {
  const r = await chat('[[delegate]] get me a subject line', null);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(llm.calls.some((c) => /^You are Copywriter/.test(c.system)), 'the Copywriter agent was run');
  assert.ok(!llm.calls.some((c) => /^You are Analyst/.test(c.system)), 'not the wrong agent');
});

test('group lead plans a goal into board tasks assigned to the right members', async () => {
  const g = await srv.api('/api/groups', undefined, token);
  const grp = g.d.groups.find((x) => x.name === 'Marketing'); assert.ok(grp);
  const r = await srv.api('/api/groups/goal', { gid: grp.id, goal: 'Launch the spring email campaign' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.tasks.map((t) => t.aid), [2, 1, 3, grp.lead]);
  assert.equal(r.d.tasks[1].after, r.d.tasks[0].id); assert.equal(r.d.tasks[2].after, r.d.tasks[1].id);
  const board = (await srv.api('/api/groups', undefined, token)).d.board;
  assert.ok(board.some((t) => t.id === r.d.parent.id && /Goal:/.test(t.title)));
});

test('real AI providers were never called', () => {
  assert.ok(llm.calls.length > 0);
  assert.doesNotMatch(srv.log(), /openrouter\.ai|api\.anthropic/i);
});
