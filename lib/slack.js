// Slack bot (Socket Mode: no public URL needed). Off unless SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID
// and SLACK_ACCOUNT_EMAIL are all set. Setup and app manifest: docs/slack.md.
//
// - Only the owner (SLACK_OWNER_USER_ID) can command it; everyone else is ignored.
// - A DM goes to the orchestrator agent (the lead of the group that orchestrates others, else Chief of Staff).
//   "desk: …" or "factory: …" (any group name) sends the text as a goal to that group instead.
// - Replies go in the thread of the message.
// - It posts only what needs the owner: tasks waiting in review that want to send/publish, finished goals, and failures.
//   Review cards have Approve / Reject buttons.
import { store, groupRoutes, helpers } from './backend.js';
import { runAgent } from './orchestrator.js';
import { onBoardEvent } from './groups.js';

const env = (k) => (process.env[k] || '').trim();
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const slackConfigured = () => ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_OWNER_USER_ID', 'SLACK_ACCOUNT_EMAIL'].every((k) => env(k));

export async function startSlack() {
  if (!slackConfigured()) { console.log('Slack bot: off (set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID and SLACK_ACCOUNT_EMAIL to turn it on)'); return null; }
  const { App, LogLevel } = await import('@slack/bolt');
  const owner = env('SLACK_OWNER_USER_ID'), email = env('SLACK_ACCOUNT_EMAIL').toLowerCase();
  const app = new App({ token: env('SLACK_BOT_TOKEN'), appToken: env('SLACK_APP_TOKEN'), socketMode: true, logLevel: LogLevel.WARN, ...(env('SLACK_SIGNING_SECRET') ? { signingSecret: env('SLACK_SIGNING_SECRET') } : {}) });
  const st = await store();
  const api = (method, pathname, b) => groupRoutes({ st, email, method, pathname, b });
  const userName = async () => { const u = parse((await st.get('as_users'))?.v, {}) || {}; return (u[email] && u[email].name) || ''; };

  app.message(async ({ message, client }) => {
    if (message.subtype || message.bot_id || message.channel_type !== 'im') return;
    if (message.user !== owner) return; // obey the owner only
    const text = String(message.text || '').trim(); if (!text) return;
    const thread_ts = message.thread_ts || message.ts;
    const reply = (t) => client.chat.postMessage({ channel: message.channel, thread_ts, text: clip(t, 3500) });
    try {
      const { groups } = await api('GET', '/api/groups');
      const m = text.match(/^([a-z][\w -]{1,40}?)\s*:\s*([\s\S]+)$/i);
      const g = m && groups.find((x) => x.name.toLowerCase() === m[1].toLowerCase().trim());
      if (g) {
        const r = await api('POST', '/api/groups/goal', { gid: g.id, goal: m[2], by: 'slack' });
        return reply(`${r.lead} planned ${r.tasks.length} task(s) for ${g.name}:\n` + r.tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n') + '\nI will post here when something needs your approval.');
      }
      const data = parse((await st.get('as_data:' + email))?.v, null);
      const orch = groups.find((x) => (x.over || []).length);
      const agent = orch ? ((data && data.agents) || []).find((a) => a.id === orch.lead) || null : null;
      await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'eyes' }).catch(() => {});
      const out = await runAgent({ st, email, userName: await userName(), data, agent, message: text, history: [], tz: 'Asia/Kolkata', mode: 'routine', ...helpers });
      await reply(out.answer + (out.approvals.length ? `\n\n${out.approvals.length} action(s) wait for your approval in AgentSphere.` : ''));
    } catch (e) { console.error('Slack message:', e.message); await reply('That failed: ' + clip(e.message, 300)); }
  });

  const decide = (decision) => async ({ ack, body, action, client }) => {
    await ack();
    if (body.user.id !== owner) return;
    let text;
    try { const r = await api('POST', '/api/board/decide', { id: action.value, decision }); text = `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${r.task.title} → ${r.task.status}${r.task.err ? ' (' + r.task.err + ')' : ''}`; }
    catch (e) { text = 'Could not ' + decision + ': ' + clip(e.message, 200); }
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
  };
  app.action('task_approve', decide('approve'));
  app.action('task_reject', decide('reject'));

  // notifications: review items that matter and failures only, never routine success
  let dm = null;
  const ownerDm = async () => dm || (dm = (await app.client.conversations.open({ users: owner })).channel.id);
  onBoardEvent(async ({ email: who, task, kind }) => {
    if (who !== email) return;
    const isGoal = task.title.startsWith('Goal: ');
    if (kind === 'blocked' && task.err && !task.err.startsWith('Rejected')) {
      return app.client.chat.postMessage({ channel: await ownerDm(), text: `:warning: Task failed: ${task.title}\n${clip(task.err, 500)}` });
    }
    if (kind !== 'review' || !(task.outbound || isGoal || !task.parent)) return;
    const text = `${task.outbound ? ':outbox_tray: Needs approval' : ':white_check_mark: Ready for review'}: *${clip(task.title, 150)}*`;
    await app.client.chat.postMessage({ channel: await ownerDm(), text, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'section', text: { type: 'mrkdwn', text: clip(task.result || '(no result text)', 2800) } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'task_approve', value: task.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'task_reject', value: task.id }] }] });
  });

  await app.start();
  console.log('Slack bot: on (Socket Mode), obeying one owner');
  return app;
}
