// Local stand-ins for outside services, so tests spend nothing and send nothing:
//   mockLLM()    OpenAI-compatible /chat/completions (the app's "ollama" provider) with scripted, deterministic replies
//   mockBuffer() Buffer's GraphQL API (accounts, channels, createPost)
//   fakeSMTP()   a tiny SMTP server that accepts AUTH and records each message
import http from 'node:http';
import net from 'node:net';

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); });

// script(req) → { text } | { tool: { name, args } } | null (default reply). req = { system, user, messages, tools, lastIsTool }
export async function mockLLM(script) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const j = JSON.parse((await body(req)) || '{}');
    const msgs = j.messages || [];
    const text = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('') : '');
    const info = { system: msgs.filter((m) => m.role === 'system').map(text).join('\n'), user: text([...msgs].reverse().find((m) => m.role === 'user') || {}),
      messages: msgs, tools: (j.tools || []).map((t) => t.function?.name || t.name), lastIsTool: msgs.length > 0 && msgs[msgs.length - 1].role === 'tool' };
    calls.push(info);
    const out = script(info) || { text: 'OK.' };
    const message = out.tool
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_' + calls.length, type: 'function', function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args || {}) } }] }
      : { role: 'assistant', content: out.text };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: j.model, choices: [{ index: 0, message, finish_reason: out.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const port = await listen(srv);
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((r) => srv.close(r)) };
}

export async function mockBuffer({ key = 'buf_test_key' } = {}) {
  const posts = [], seen = [];
  const srv = http.createServer(async (req, res) => {
    const j = JSON.parse((await body(req)) || '{}'); const q = String(j.query || '');
    seen.push({ auth: req.headers.authorization, q: q.slice(0, 40) });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + key) { res.statusCode = 401; return res.end(JSON.stringify({ errors: [{ message: 'Unauthorized' }] })); }
    if (q.includes('GetOrganizations')) return res.end(JSON.stringify({ data: { account: { organizations: [{ id: 'org1', name: 'Test Agency' }] } } }));
    if (q.includes('GetChannels')) return res.end(JSON.stringify({ data: { channels: [{ id: 'ch_li', name: 'Test Agency', service: 'linkedin' }, { id: 'ch_x', name: 'testagency', service: 'twitter' }] } }));
    if (q.includes('CreatePost')) { posts.push(j.variables.input); return res.end(JSON.stringify({ data: { createPost: { post: { id: 'p' + posts.length, dueAt: null } } } })); }
    res.end(JSON.stringify({ data: {} }));
  });
  const port = await listen(srv);
  return { url: `http://127.0.0.1:${port}/`, key, posts, seen, close: () => new Promise((r) => srv.close(r)) };
}

export async function fakeSMTP() {
  const mails = [];
  const srv = net.createServer((sock) => {
    let buf = '', inData = false, cur = null;
    const say = (l) => sock.write(l + '\r\n');
    say('220 fake ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; mails.push(cur); say('250 OK queued'); } else cur.data += line.replace(/^\./, '') + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
        else if (cmd === 'HELO') say('250 OK');
        else if (cmd === 'AUTH') { if (/PLAIN \S+/i.test(line)) say('235 OK'); else if (/LOGIN/i.test(line)) { cur = cur || {}; say('334 VXNlcm5hbWU6'); cur.step = 1; } else say('334 '); }
        else if (cur && cur.step === 1) { cur.step = 2; say('334 UGFzc3dvcmQ6'); }
        else if (cur && cur.step === 2) { cur.step = 0; say('235 OK'); }
        else if (cmd === 'MAIL') { cur = { from: line, to: [], data: '' }; say('250 OK'); }
        else if (cmd === 'RCPT') { cur.to.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '')); say('250 OK'); }
        else if (cmd === 'DATA') { inData = true; say('354 go'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') say('250 OK');
        else if (/^\S+$/.test(line) && cur === null) say('235 OK'); // AUTH PLAIN continuation
        else say('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  return { port, mails, close: () => new Promise((r) => srv.close(r)) };
}
