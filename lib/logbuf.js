// Keeps the last 2000 server log lines in memory for Settings → Logs & diagnostics (shown redacted).
const LINES = [];
const MAX = 2000;
function wrap(level) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    try { LINES.push({ at: Date.now(), level, text: a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(' ').slice(0, 4000) }); if (LINES.length > MAX) LINES.splice(0, LINES.length - MAX); } catch { /* never break logging */ }
    orig(...a);
  };
}
for (const l of ['log', 'warn', 'error']) wrap(l);
export const logLines = (n = 500) => LINES.slice(-n);
