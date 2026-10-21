// Web access for agents, with no key needed: web_search (Tavily when TAVILY_API_KEY is set, otherwise DuckDuckGo's
// HTML results page) and read_webpage (fetch a page and keep its readable text). WEB_SEARCH=off turns both off.
import dns from 'node:dns/promises';
import net from 'node:net';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AaaS';
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '—', ndash: '–' };
function ent(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
  });
}
const strip = (h) => ent(String(h || '').replace(/<[^>]+>/g, ' '));
export const webOn = () => env('WEB_SEARCH').toLowerCase() !== 'off';

function ipv4Private(ip) {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
function ipPrivate(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (s.includes(':')) {
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? ipv4Private(mapped[1]) : false;
  }
  return ipv4Private(s);
}
const BAD_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal|metadata)$/i;

// Refuse private, link-local and loopback targets. Used by page reading and the agent browser.
export async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Give a full http(s) link.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links are allowed.');
  if (u.username || u.password) throw new Error('Links with a username or password are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || BAD_HOST.test(host)) throw new Error('That address is not allowed.');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw new Error('Could not look up that address.');
  if (ips.some(ipPrivate)) throw new Error('Private and internal addresses are not allowed.');
  return u;
}

export async function webSearch(query, n = 6) {
  query = String(query || '').trim().slice(0, 300); if (!query) return [];
  if (env('TAVILY_API_KEY')) {
    const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ api_key: env('TAVILY_API_KEY'), query, max_results: n }) });
    const j = await r.json().catch(() => ({}));
    return (j.results || []).map((x) => ({ title: clip(x.title, 160), url: x.url, text: clip(x.content, 900) }));
  }
  const base = env('WEB_SEARCH_URL', 'https://html.duckduckgo.com/html/');
  const r = await fetch(base, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'text/html' }, body: new URLSearchParams({ q: query, kl: 'wt-wt' }) });
  if (!r.ok) throw new Error('web search answered ' + r.status);
  const html = await r.text(), out = [];
  const parts = html.split(/<a[^>]+class="[^"]*result__a[^"]*"/).slice(1);
  for (const part of parts) {
    if (out.length >= n) break;
    const href = (part.match(/href="([^"]+)"/) || [])[1] || '', title = (part.match(/>([\s\S]*?)<\/a>/) || [])[1] || '';
    const snip = (part.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/) || [])[1] || '';
    let url = ent(href);
    const ud = url.match(/[?&]uddg=([^&]+)/); if (ud) url = decodeURIComponent(ud[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: clip(strip(title), 160), url, text: clip(strip(snip), 600) });
  }
  return out;
}

async function fetchPublic(url, maxRedirects = 3) {
  let current = String(url || '').trim();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current);
    const r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('The page redirected without a destination.');
      current = new URL(loc, current).toString();
      continue;
    }
    return r;
  }
  throw new Error('Too many redirects.');
}

export async function readPage(url, max = 8000) {
  const r = await fetchPublic(url);
  if (!r.ok) throw new Error('The page answered ' + r.status);
  const type = r.headers.get('content-type') || '', raw = (await r.text()).slice(0, 2_000_000);
  if (!/html|xml/.test(type)) return { title: url, text: clip(raw, max) };
  const title = clip(strip((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || url), 200);
  let body = (raw.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || raw;
  body = body.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n');
  return { title, text: strip(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max) };
}
