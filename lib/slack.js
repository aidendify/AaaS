// Slack bot (Socket Mode: no public URL needed). Off unless SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID
// and SLACK_ACCOUNT_EMAIL are all set. Setup and app manifest: docs/slack.md.
//
// - Only the owner (SLACK_OWNER_USER_ID) can command it; everyone else is ignored.
// - A DM goes to the orchestrator agent: SLACK_AGENT_ID if set, else the lead of the group that orchestrates
//   others. If neither resolves, the bot says so instead of silently answering as another agent.
// - Each DM (top level) and each thread is one ongoing conversation: the last turns are kept in as_slack:<email>.
//   Top-level DMs are answered in the DM itself; messages inside a thread are answered in that thread.
//   "desk: …" or "factory: …" (any group name) sends the text as a goal to that group instead.
// - Replies go in the thread of the message.
// - It posts only what needs the owner: tasks waiting in review that want to send/publish, finished goals, and failures.
//   Review cards have Approve / Reject buttons.
import { store, groupRoutes, helpers } from './backend.js';
import { runAgent, decideApproval } from './orchestrator.js';
import { onBoardEvent } from './groups.js';
import { openRemoteBrowser, closeRemoteBrowser, remoteBrowserStatus, remoteBrowserMessage, setRemoteLinkSender, onRemoteBrowserClosed } from './remote-browser.js';

const env = (k) => (process.env[k] || '').trim();
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Post a notice to the notifications channel (or owner DM) while the bot runs; false when Slack is off.
let ownerNotifier = null;
export async function notifyOwner(text) { if (!ownerNotifier || !running) return false; await ownerNotifier(text); return true; }
export const slackStatus = () => ({ configured: slackConfigured(), running: !!running });
export const slackConfigured = () => ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_OWNER_USER_ID', 'SLACK_ACCOUNT_EMAIL'].every((k) => env(k));

// Which agent answers DMs. Exported so tests can check it.
export function resolveDmAgent(groups, data) {
  const agents = (data && data.agents) || [];
  const want = Number(env('SLACK_AGENT_ID'));
  if (want) return agents.find((a) => a.id === want) || null;
  const orch = (groups || []).find((x) => (x.over || []).length);
  return orch ? agents.find((a) => a.id === orch.lead) || null : null;
}

const HISTORY_TURNS = 20;
const convKey = (m) => m.channel + ':' + (m.thread_ts || 'dm');

// The DM handler, separate from Bolt so it can be driven by a test harness with a fake client.
export function makeDmHandler({ st, email, owner, api, userName }) {
  const histKey = 'as_slack:' + email;
  const loadHist = async (k) => ((parse((await st.get(histKey))?.v, {}) || {})[k] || []);
  const saveHist = async (k, turns) => {
    const all = parse((await st.get(histKey))?.v, {}) || {};
    all[k] = turns.slice(-HISTORY_TURNS);
    const keys = Object.keys(all); if (keys.length > 200) for (const x of keys.slice(0, keys.length - 200)) delete all[x]; // cap stored chats
    await st.put(histKey, JSON.stringify(all), Date.now());
  };
  // Every owner message we picked up, so catch-up after a restart/outage never answers one twice.
  const seenKey = 'as_slack_seen:' + email;
  const markSeen = async (ts) => {
    const seen = parse((await st.get(seenKey))?.v, []) || [];
    if (seen.includes(ts)) return false;
    seen.push(ts); await st.put(seenKey, JSON.stringify(seen.slice(-500)), Date.now()); return true;
  };
  const isSeen = async (ts) => (parse((await st.get(seenKey))?.v, []) || []).includes(ts);
  async function handle(message, client) {
    if (message.subtype || message.bot_id || message.channel_type !== 'im') return;
    if (message.user !== owner) return; // obey the owner only
    const text = String(message.text || '').trim(); if (!text) return;
    if (!(await markSeen(message.ts))) return; // already handled (Slack retry or catch-up)
    client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'eyes' }).catch(() => {}); // "got it", right away
    const thread_ts = message.thread_ts; // top-level DM: reply in the DM; in a thread: reply in the thread
    const reply = (t) => client.chat.postMessage({ channel: message.channel, ...(thread_ts ? { thread_ts } : {}), text: clip(t, 3500) });
    try {
      // Remote browser commands (owner DM only; the link is never posted in a channel).
      const bc = text.toLowerCase().replace(/[.!?\s]+$/, '').replace(/^please\s+/, '');
      if (/^(open (the )?browser|browser|browser open|remote browser)$/.test(bc)) {
        await reply('Opening the browser, this takes about 20 seconds…');
        const r = await openRemoteBrowser();
        return reply(remoteBrowserMessage(r) + (r.reused ? '\n(It was already open; same link.)' : ''));
      }
      if (/^(close (the )?browser|browser close|stop (the )?browser)$/.test(bc)) {
        const r = await closeRemoteBrowser();
        return reply(r.was ? 'Browser closed. Sign-ins are saved and the agents can use the browser again.' : 'The browser was not open.');
      }
      if (/^(browser status|status browser|is the browser open)$/.test(bc)) {
        const r = remoteBrowserStatus();
        return reply(r.state === 'open' ? `Browser is open (${r.viewers} viewer(s)). Closes about ${r.expiresText} if idle. Say "browser" for the link again, or "close browser".` : r.state === 'starting' ? 'Browser is starting…' : `Browser is closed. Say "open browser" to get a link (closes after ${r.idleMin} idle minutes).`);
      }
      const { groups } = await api('GET', '/api/groups');
      const m = text.match(/^([a-z][\w -]{1,40}?)\s*:\s*([\s\S]+)$/i);
      const g = m && groups.find((x) => x.name.toLowerCase() === m[1].toLowerCase().trim());
      if (g) {
        const r = await api('POST', '/api/groups/goal', { gid: g.id, goal: m[2], by: 'slack' });
        return reply(`${r.lead} planned ${r.tasks.length} task(s) for ${g.name}:\n` + r.tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n') + '\nI will post here when something needs your approval.');
      }
      const data = parse((await st.get('as_data:' + email))?.v, null);
      const agent = resolveDmAgent(groups, data);
      if (!agent) return reply('No orchestrator agent is set up. Set an orchestrator group (or SLACK_AGENT_ID) in AIdentify.');
      const k = convKey(message), history = await loadHist(k);
      const out = await runAgent({ st, email, userName: await userName(), data, agent, message: text, history, tz: (process.env.APP_TIMEZONE || 'Asia/Kolkata'), mode: 'chat', ...helpers });
      const answer = (out.answer || '') + (out.question ? (out.answer ? '\n\n' : '') + out.question.q : '')
        + (out.approvals.length ? `\n\n${out.approvals.length} action(s) wait for your approval in AIdentify.` : '');
      await saveHist(k, [...history, { r: 'u', t: text }, { r: 'a', t: answer }]);
      console.log(`Slack DM answered by agent ${agent.id} (${agent.name})`);
      return reply(answer || 'Done.');
    } catch (e) { console.error('Slack message:', e.message); await reply('That failed: ' + clip(e.message, 300)).catch(() => {}); }
  }
  // Catch-up: answer owner DMs that arrived while we were down (restart, box pause, dead socket).
  // An owner message counts as unanswered when it is the LAST message of its conversation (the DM or a thread),
  // is younger than maxAgeMin, and was never picked up.
  handle.catchUp = async (client, { maxAgeMin = 120 } = {}) => {
    const ch = (await client.conversations.open({ users: owner })).channel.id;
    const oldest = String(Date.now() / 1000 - maxAgeMin * 60);
    const h = await client.conversations.history({ channel: ch, oldest, limit: 100 });
    const top = h.messages || [], todo = [];
    if (top[0] && top[0].user === owner && !top[0].thread_ts) todo.push(top[0]); // newest top-level message
    for (const m of top) {
      if (!m.reply_count || Number(m.latest_reply || 0) < Number(oldest)) continue;
      const r = await client.conversations.replies({ channel: ch, ts: m.ts, limit: 200 });
      const last = (r.messages || []).slice(-1)[0];
      if (last && last.ts !== m.ts && last.user === owner) todo.push(last);
    }
    let n = 0;
    for (const m of todo) {
      if (m.bot_id || m.subtype || (await isSeen(m.ts))) continue;
      n++; console.log('Slack catch-up: answering a missed DM from', new Date(Number(m.ts) * 1000).toISOString());
      handle({ ...m, channel: ch, channel_type: 'im' }, client).catch((e) => console.error('Slack catch-up:', e.message));
    }
    return n;
  };
  return handle;
}

let running = null, watch = null;
export async function stopSlack() {
  if (watch) clearInterval(watch);
  const app = running; running = null;
  if (app) await Promise.race([app.stop().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

export async function startSlack() {
  if (!slackConfigured()) { console.log('Slack bot: off (set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID and SLACK_ACCOUNT_EMAIL to turn it on)'); return null; }
  const { App, LogLevel } = await import('@slack/bolt');
  const owner = env('SLACK_OWNER_USER_ID'), email = env('SLACK_ACCOUNT_EMAIL').toLowerCase();
  const { SocketModeReceiver } = await import('@slack/bolt');
  // Pong timeout 5 s (the default) is too tight while the box is busy; reconnects still happen on real drops.
  const receiver = new SocketModeReceiver({ appToken: env('SLACK_APP_TOKEN'), logLevel: LogLevel.WARN, clientPingTimeout: 15000, serverPingTimeout: 45000 });
  const app = new App({ token: env('SLACK_BOT_TOKEN'), receiver, logLevel: LogLevel.WARN });
  const st = await store();
  const api = (method, pathname, b) => groupRoutes({ st, email, method, pathname, b });
  const userName = async () => { const u = parse((await st.get('as_users'))?.v, {}) || {}; return (u[email] && u[email].name) || ''; };

  const handle = makeDmHandler({ st, email, owner, api, userName });
  // Return at once so the event is acknowledged immediately; the answer is posted when the agent is done.
  app.message(async ({ message, client }) => { handle(message, client).catch((e) => console.error('Slack message:', e.message)); });

  const decide = (decision) => async ({ ack, body, action, client }) => {
    await ack();
    if (body.user.id !== owner) return;
    let text;
    try { const r = await api('POST', '/api/board/decide', { id: action.value, decision }); text = `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${r.task.title} → ${r.task.status}${r.task.err ? ' (' + r.task.err + ')' : ''}`; }
    catch (e) { text = 'Could not ' + decision + ': ' + clip(e.message, 200); }
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
  };
  // one proposed reply/action at a time (cards list each with its own buttons)
  const decideOne = (approve) => async ({ ack, body, action, client }) => {
    await ack();
    if (body.user.id !== owner) return;
    let line;
    try {
      const r = await decideApproval({ st, email, id: action.value, approve, secret: helpers.secret });
      line = r.error ? 'That item no longer exists.' : (approve ? r.approval.status === 'declined' : r.approval.status !== 'declined') ? `Already ${r.approval.status} earlier, nothing changed: ${clip(r.approval.summary, 150)}` : `${approve ? 'Approved' : 'Rejected'}: ${clip(r.approval.summary, 150)} → ${r.approval.status}${r.approval.result ? ' (' + clip(r.approval.result, 200) + ')' : ''}`;
    } catch (e) { line = 'Could not ' + (approve ? 'approve' : 'reject') + ': ' + clip(e.message, 200); }
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: line }).catch(() => {});
  };
  app.action('appr_approve', decideOne(true));
  app.action('appr_reject', decideOne(false));
  app.action('task_approve', decide('approve'));
  app.action('task_reject', decide('reject'));

  // notifications: review items that matter and failures only, never routine success
  let dm = null;
  const ownerDm = async () => dm || (dm = (await app.client.conversations.open({ users: owner })).channel.id);
  // SLACK_NOTIFY_CHANNEL (a channel id like C0123ABCD, or #name): review cards, failures and briefs go there; the DM stays for conversation.
  const notifyTo = async () => env('SLACK_NOTIFY_CHANNEL') || ownerDm();
  // remote browser: links and auto-close notices go to the owner's DM only, never to the notify channel
  ownerNotifier = async (t) => app.client.chat.postMessage({ channel: await notifyTo(), text: t });
  setRemoteLinkSender(async (t) => app.client.chat.postMessage({ channel: await ownerDm(), text: t }));
  onRemoteBrowserClosed(async (why) => { app.client.chat.postMessage({ channel: await ownerDm(), text: `Browser closed (${why}). Say "open browser" for a new link.` }).catch(() => {}); });
  onBoardEvent(async ({ email: who, task, kind }) => {
    if (who !== email) return;
    const isGoal = task.title.startsWith('Goal: ');
    const off = (k) => env(k) === 'off';
    if (kind === 'brief' && off('NOTIFY_BRIEF')) return;
    if (kind === 'blocked' && off('NOTIFY_FAILED')) return;
    if (kind === 'review' && off('NOTIFY_REVIEW')) return;
    if (kind === 'brief') return app.client.chat.postMessage({ channel: await notifyTo(), text: clip(task.result || task.err || '(empty brief)', 3500) });
    if (kind === 'blocked' && task.err && !task.err.startsWith('Rejected')) {
      return app.client.chat.postMessage({ channel: await notifyTo(), text: `:warning: Task failed: ${task.title}\n${clip(task.err, 500)}` });
    }
    if (kind !== 'review' || !(task.outbound || isGoal || !task.parent)) return;
    const text = `${task.outbound ? ':outbox_tray: Needs approval' : ':white_check_mark: Ready for review'}: *${clip(task.title, 150)}*`;
    // each proposed reply gets its own card, so the owner can approve some and reject others
    if (task.outbound) {
      const all = parse((await st.get('as_appr:' + email))?.v, []) || [], mine = all.filter((a) => (task.approvals || []).includes(a.id) && a.status === 'pending');
      await app.client.chat.postMessage({ channel: await notifyTo(), text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text + `\n${mine.length} item(s) below. Approve sends that one only.` } },
        { type: 'section', text: { type: 'mrkdwn', text: clip(task.result || '', 2500) } }] });
      for (const a of mine.slice(0, 15)) {
        const i = a.input || {}, body = a.op === 'reply' ? `*${clip(i.lead, 300)}*\n<${i.url}|${clip(i.platform || 'link', 20)}>${i.to ? ' · ' + clip(i.to, 60) : ''}\n>${clip(i.text, 1500).replace(/\n/g, '\n>')}` : clip(a.summary, 500);
        await app.client.chat.postMessage({ channel: await notifyTo(), text: 'Approve? ' + clip(a.summary, 150), blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: body } },
          { type: 'actions', elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'appr_approve', value: a.id },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'appr_reject', value: a.id }] }] });
      }
      return;
    }
    await app.client.chat.postMessage({ channel: await notifyTo(), text, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'section', text: { type: 'mrkdwn', text: clip(task.result || '(no result text)', 2800) } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'task_approve', value: task.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'task_reject', value: task.id }] }] });
  });

  // ---- staying connected ----
  // Socket Mode reconnects on its own after drops (Slack refreshes sockets every few hours, networks blip, the box
  // sleeps and wakes). On top of that: log every state change, a heartbeat, start retries with backoff, and a
  // watchdog that exits (so the supervisor restarts us) if the socket stays down for SLACK_WATCHDOG_MIN minutes.
  const sock = app.receiver && app.receiver.client;
  const health = { connected: false, since: Date.now(), events: 0, lastEvent: 0 };
  if (sock && sock.on) {
    for (const ev of ['connecting', 'reconnecting', 'disconnected']) sock.on(ev, () => { if (health.connected || ev !== 'disconnected') console.log('Slack socket:', ev); health.connected = false; health.since = Date.now(); });
    sock.on('connected', () => {
      console.log('Slack socket: connected'); health.connected = true; health.since = Date.now();
      setTimeout(() => handle.catchUp(app.client).catch((e) => console.error('Slack catch-up:', e.message)), 3000); // answer what we missed
    });
    sock.on('slack_event', () => { health.events++; health.lastEvent = Date.now(); });
  }
  for (let attempt = 0, wait = 5000; ; attempt++) {
    try { await app.start(); break; }
    catch (e) {
      console.error(`Slack start failed (${clip(e.message, 160)}), retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 5 * 60 * 1000);
    }
  }
  health.connected = true; health.since = Date.now();
  console.log('Slack bot: on (Socket Mode), obeying one owner');
  const beatMin = Math.max(1, Number(env('SLACK_HEARTBEAT_MIN')) || 15), dogSec = Math.max(30, Number(env('SLACK_WATCHDOG_SEC')) || 60);
  let lastTick = Date.now(), lastMono = process.hrtime.bigint(), lastBeat = Date.now(), forcing = false;
  // Reconnect by hand: drop the socket and open a new one; restart the server if even that fails.
  const forceReconnect = async (why) => {
    if (forcing) return; forcing = true;
    console.log('Slack socket: forcing reconnect (' + why + ')');
    try { await Promise.race([(async () => { try { await sock.disconnect(); } catch { /* already down */ } await sock.start(); })(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 30000))]); }
    catch (e) { console.error('Slack reconnect failed (' + e.message + '), restarting the server.'); process.exit(75); }
    finally { forcing = false; }
  };
  watch = setInterval(async () => {
    const now = Date.now(), gap = now - lastTick, mono = process.hrtime.bigint(), monoGap = Number(mono - lastMono) / 1e6; lastTick = now; lastMono = mono;
    // wall clock jumped but the monotonic clock did not → the box/process was paused; both jumped → the event loop was blocked
    if (gap > 45 * 1000) {
      console.log(`Timer late by ${Math.round(gap / 1000)}s (monotonic ${Math.round(monoGap / 1000)}s): ${monoGap < gap - 20000 ? 'process was paused (box sleep)' : 'event loop was blocked'}`);
      forceReconnect('woke after a pause'); return;
    }
    if (!health.connected && now - health.since > dogSec * 1000) forceReconnect(`socket down ${Math.round((now - health.since) / 1000)}s`);
    if (now - lastBeat >= beatMin * 60 * 1000) {
      lastBeat = now;
      const ok = await app.client.auth.test().then((r) => r.ok).catch(() => false);
      console.log(`Slack heartbeat ${new Date().toISOString()}: socket ${health.connected ? 'up' : 'down'}, API ${ok ? 'ok' : 'unreachable'}, ${health.events} events`);
    }
  }, 15 * 1000);
  watch.unref();
  running = app;
  return app;
}
