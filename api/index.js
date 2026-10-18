// Vercel serverless function. vercel.json rewrites every /api/* request here (data, sign-in, AI).
import { handle, HttpError } from '../lib/backend.js';

export const config = { maxDuration: 60 };

async function rawBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  let s = ''; for await (const c of req) s += c; return s;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'vercel';
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await rawBody(req);
    const out = await handle({ method: req.method, pathname: url.pathname, body, headers: req.headers, ip, query: url.searchParams });
    if (out && out.__redirect) { res.setHeader('Location', out.__redirect); return res.status(302).end(); }
    if (out && out.__bytes) { res.setHeader('Content-Type', out.__type || 'application/octet-stream'); return res.status(200).send(out.__bytes); }
    if (out && out.__html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(200).send(out.__html); }
    if (url.pathname === '/api/health') { out.ai = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.XAI_API_KEY); out.byok = true; out.aiCap = Number(process.env.PLATFORM_AI_BUDGET_USD) > 0; }
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.extra || {}) });
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
