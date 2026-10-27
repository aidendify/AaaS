// Vercel serverless function. vercel.json rewrites every /api/* request here (data, sign-in, AI).
import { handle, HttpError } from '../lib/backend.js';
import { mockOn } from '../lib/llm.js';
import { obsScope, obs, obsDone } from '../lib/obs.js';

export const config = { maxDuration: 60 };

async function rawBody(req) {
  // Vercel parses JSON bodies lazily and its req.body getter throws on broken JSON: answer 400, not 500
  let b; try { b = req.body; } catch { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.'); }
  if (b !== undefined) return typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf8') : JSON.stringify(b);
  let s = ''; for await (const c of req) s += c; return s;
}

export default function handler(req, res) {
  return obsScope(() => {
    const t0 = Date.now(), store = obs();
    res.on('finish', () => { try { obsDone({ method: req.method, pathname: new URL(req.url, 'http://x').pathname, status: res.statusCode, ms: Date.now() - t0, store }); } catch { /* never break a response */ } });
    return inner(req, res);
  });
}
async function inner(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'vercel';
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/c/') || url.pathname.startsWith('/book/') || url.pathname.startsWith('/api/clinic/form/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await rawBody(req);
    const out = await handle({ method: req.method, pathname: url.pathname, body, headers: req.headers, ip, query: url.searchParams });
    if (out && out.__redirect) { res.setHeader('Location', out.__redirect); return res.status(302).end(); }
    if (out && out.__bytes) { if (out.__name) res.setHeader('Content-Disposition', 'attachment; filename="' + out.__name + '"'); res.setHeader('Content-Type', out.__type || 'application/octet-stream'); return res.status(200).send(out.__bytes); }
    if (out && out.__html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(200).send(out.__html); }
    if (out && typeof out.__text === 'string') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(out.__text); }
    if (url.pathname === '/api/health') { out.ai = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.XAI_API_KEY); out.byok = true; out.aiCap = Number(process.env.PLATFORM_AI_BUDGET_USD) > 0; out.aiMock = mockOn() || undefined; }
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.extra || {}) });
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
