#!/usr/bin/env node
// Read-only social analytics snapshot in the agents' own browser profile (lib/browser.js settings and lock).
// It only opens analytics/profile pages and reads text. It never clicks like, follow or post, and never
// changes settings. A site that is not signed in is reported as "not signed in", never guessed.
//
//   npm run social:snapshot [-- --out DIR] [--date YYYY-MM-DD] [--no-retry] [--probe]
// Exit codes: 0 all sites read | 3 report written, some sites not signed in or unreadable
//             2 browser busy (profile in use), even after one retry | 1 error
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env only fills variables that are not already set (same rule as server.js)
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const now = () => new Date();
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hm = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
const OUT = path.resolve(arg('out', process.env.SOCIAL_ANALYTICS_DIR || '/workspace/social/analytics'));
const DATE = arg('date', ymd(now()));
const SHOTS = path.join(OUT, 'shots');
const X_USER = process.env.SOCIAL_X_USER || 'malladiphani';
const FB_USER = process.env.SOCIAL_FB_USER || 'srinivasa.phanindra.1';
const LI_NAME = process.env.SOCIAL_LI_NAME || 'Malladi Phanindra';
const RETRY_MIN = Number(process.env.SOCIAL_RETRY_MIN || 4);
const log = (...a) => console.log(`[${hm(now())} IST]`, ...a);

const { profileLock, releaseProfileLock, browserLaunchOptions } = await import(path.join(ROOT, 'lib/browser.js'));
const profile = path.resolve(ROOT, (process.env.BROWSER_PROFILE_DIR || 'data/browser-profile').trim());
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));

// ---------- number helpers ----------
const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').trim().match(/^([\d.]+)\s*([KkMm])?$/);
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
  return Math.round(v);
};
const N = '([\\d][\\d,.]*\\s?[KkMm]?)';
const find = (text, res) => { for (const re of res) { const m = text.match(re); if (m) return m[1].trim(); } return null; };

// ---------- browser ----------
async function openBrowser() {
  const held = profileLock(profile, false);
  if (held) return { busy: `profile lock held by pid ${held} (sign-in window, remote browser or the server's agents)` };
  const { chromium } = await import('playwright');
  profileLock(profile, true);
  try {
    const opts = { ...browserLaunchOptions({ show: false }), ...(CHROME && !process.env.BROWSER_EXECUTABLE ? { channel: 'chrome' } : {}), viewport: { width: 1366, height: 900 } };
    const ctx = await chromium.launchPersistentContext(profile, opts);
    return { ctx };
  } catch (e) {
    releaseProfileLock(profile);
    if (/ProcessSingleton|SingletonLock|in use|already running/i.test(e.message)) return { busy: 'Chrome reports the profile is already open' };
    throw e;
  }
}

// Read-only: navigate, wait, scroll a little to load lazy numbers, read text, screenshot. No clicks.
async function visit(ctx, site, name, url, wait = 6000) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const r = { url, finalUrl: '', text: '', shot: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(wait);
    await page.mouse.wheel(0, 600).catch(() => {});
    await page.waitForTimeout(1500);
    r.finalUrl = page.url();
    r.text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    r.shot = path.join(SHOTS, `${DATE}-${site}-${name}.png`);
    await page.screenshot({ path: r.shot, fullPage: false });
    if (flag('probe')) fs.writeFileSync(r.shot.replace(/\.png$/, '.txt'), r.finalUrl + '\n\n' + r.text);
  } catch (e) { r.error = e.message.split('\n')[0]; }
  await page.close().catch(() => {});
  return r;
}

const signedOut = {
  x: (r) => /\/(i\/flow\/login|login|i\/flow\/signup)/.test(r.finalUrl) || /Sign in to X|Don.t miss what.s happening|Join X today/i.test(r.text.slice(0, 3000)),
  linkedin: (r) => /\/(login|authwall|uas\/login|checkpoint|signup)/.test(r.finalUrl) || /Sign in to LinkedIn|Join LinkedIn|Agree & Join/i.test(r.text.slice(0, 3000)),
  facebook: (r) => /\/login|checkpoint/.test(r.finalUrl) || /Log in to Facebook|Log Into Facebook|Create new account/i.test(r.text.slice(0, 3000)),
};

async function readX(ctx) {
  const out = { site: 'X', handle: '@' + X_USER, signedIn: null, shots: [], notes: [] };
  const prof = await visit(ctx, 'x', 'profile', `https://x.com/${X_USER}`);
  const ov = await visit(ctx, 'x', 'overview', 'https://x.com/i/account_analytics', 9000);
  const ct = await visit(ctx, 'x', 'content', 'https://x.com/i/account_analytics/content', 9000);
  for (const p of [prof, ov, ct]) { if (p.shot) out.shots.push(p.shot); if (p.error) out.notes.push(`${p.url}: ${p.error}`); }
  // public counts on the profile page are valid whoever is signed in
  out.followers = num(find(prof.text, [new RegExp(N + '\\s*Followers', 'i')]));
  out.following = num(find(prof.text, [new RegExp(N + '\\s*Following', 'i')]));
  out.posts = num(find(prof.text, [new RegExp(N + '\\s*posts', 'i')]));
  if (signedOut.x(ov) && signedOut.x(prof)) { out.signedIn = false; return out; }
  out.viewer = (prof.text.match(/\nPost\n[^\n]*\n@(\w+)/) || ov.text.match(/\nPost\n[^\n]*\n@(\w+)/) || [])[1] || '';
  if (out.viewer && out.viewer.toLowerCase() !== X_USER.toLowerCase()) { out.signedIn = 'other'; out.notes.push(`Signed in as @${out.viewer}, not @${X_USER}: analytics (verified followers, impressions, Content) not read. Followers taken from the public profile page.`); return out; }
  out.signedIn = true;
  const ver = ov.text.match(/Verified followers\s*\n?\s*([\d,]+)\s*\/\s*([\d,.]+\s?[KkMm]?)/i);
  if (ver) { out.verified = num(ver[1]); out.verifiedTotal = num(ver[2]); }
  else out.notes.push(/Premium|Subscribe|Upgrade|Get verified/i.test(ov.text) ? 'Overview did not show "Verified followers" (looks Premium-locked)' : 'Overview did not show "Verified followers"');
  out.impressions = find(ov.text, [new RegExp('Impressions\\s*\\n?\\s*' + N, 'i')]);
  out.engagements = find(ov.text, [new RegExp('Engagements\\s*\\n?\\s*' + N, 'i')]);
  out.overviewRange = find(ov.text, [/\b(\d+D|7 days|28 days|90 days|1Y)\b/]);
  // Content tab: count rows that look like post rows with a date
  const rows = ct.text.split('\n').filter((l) => /\b(Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)\s+\d{1,2}\b/.test(l));
  out.contentRows = ct.error || signedOut.x(ct) ? null : rows.length;
  if (out.followers == null) out.notes.push('Followers number not found on the profile page');
  return out;
}

async function readLinkedIn(ctx) {
  const out = { site: 'LinkedIn', handle: 'Malladi Phanindra', signedIn: null, shots: [], notes: [] };
  const dash = await visit(ctx, 'linkedin', 'dashboard', 'https://www.linkedin.com/dashboard/', 8000);
  const aud = await visit(ctx, 'linkedin', 'audience', 'https://www.linkedin.com/analytics/creator/audience/', 8000);
  const con = await visit(ctx, 'linkedin', 'content', 'https://www.linkedin.com/analytics/creator/content/', 8000);
  for (const p of [dash, aud, con]) { if (p.shot) out.shots.push(p.shot); if (p.error) out.notes.push(`${p.url}: ${p.error}`); }
  if (signedOut.linkedin(dash) && signedOut.linkedin(aud)) { out.signedIn = false; return out; }
  const me = await visit(ctx, 'linkedin', 'me', 'https://www.linkedin.com/in/me/', 6000);
  if (me.shot) out.shots.push(me.shot);
  out.viewer = (me.text.match(/\n\s*([^\n]{3,60})\n\s*(?:He\/Him|She\/Her|They\/Them)?\s*\n?[^\n]*\n?[^\n]*Contact info/) || [])[1] || '';
  if (!me.text.includes(LI_NAME)) { out.signedIn = 'other'; out.notes.push(`The signed-in LinkedIn account is not ${LI_NAME} (its own profile page does not show that name): its analytics were not used.`); return out; }
  out.signedIn = true;
  const all = [aud.text, dash.text].join('\n');
  out.followers = num(find(all, [new RegExp('Total followers\\s*\\n?\\s*' + N, 'i'), new RegExp(N + '\\s*\\n?\\s*Total followers', 'i'), new RegExp(N + '\\s*followers', 'i')]));
  out.impressions = find([con.text, dash.text].join('\n'), [new RegExp(N + '\\s*\\n?\\s*Impressions', 'i'), new RegExp('Impressions\\s*\\n?\\s*' + N, 'i'), new RegExp(N + '\\s*\\n?\\s*Post impressions', 'i')]);
  out.impressionsRange = find([con.text, dash.text].join('\n'), [/(Past \d+ days)/i]);
  if (out.followers == null) out.notes.push('Followers number not found');
  return out;
}

async function readFacebook(ctx) {
  const out = { site: 'Facebook', handle: FB_USER, signedIn: null, shots: [], notes: [] };
  const prof = await visit(ctx, 'facebook', 'profile', `https://www.facebook.com/${FB_USER}`, 7000);
  const ins = await visit(ctx, 'facebook', 'insights', 'https://www.facebook.com/professional_dashboard/insights/', 9000);
  for (const p of [prof, ins]) { if (p.shot) out.shots.push(p.shot); if (p.error) out.notes.push(`${p.url}: ${p.error}`); }
  if (signedOut.facebook(prof) && signedOut.facebook(ins)) { out.signedIn = false; return out; }
  out.followers = num(find(prof.text, [new RegExp(N + '\\s*followers', 'i')]));
  out.followersText = find(prof.text, [new RegExp(N + '\\s*followers', 'i')]);
  // on your own profile Facebook shows "Edit profile"; on someone else's it shows "Add friend"/"Follow"
  if (!/Edit profile/i.test(prof.text) && /\n(Add friend|Follow|Message)\n/.test(prof.text)) { out.signedIn = 'other'; out.notes.push(`Signed in as a different Facebook account (the ${FB_USER} profile shows "Add friend"): reach not read. Followers taken from the public profile.`); return out; }
  out.signedIn = true;
  out.reach = find(ins.text, [new RegExp('(?:Post reach|Reach|Viewers)\\s*\\n?\\s*' + N, 'i')]);
  out.reachRange = find(ins.text, [/(Last \d+ days|Past \d+ days)/i]);
  if (signedOut.facebook(ins)) out.notes.push('Professional dashboard insights not available in this profile');
  if (out.followers == null) out.notes.push('Followers number not found on the profile page');
  return out;
}

// ---------- report ----------
const v = (x) => (x == null || x === '' ? 'not found' : typeof x === 'number' ? x.toLocaleString('en-US') : x);
function report(res, t0, t1) {
  const [x, li, fb] = res;
  const need = res.filter((s) => s.signedIn !== true).map((s) => s.site + (s.signedIn === 'other' ? ' (signed in as another account)' : s.signedIn === false ? ' (not signed in)' : ' (unreadable)'));
  const L = [];
  L.push(`# Social analytics ${DATE} (IST)`);
  L.push(`Snapshot ~${hm(t0)} IST (finished ${hm(t1)} IST) by the AaaS browser (npm run social:snapshot, profile ${path.relative(ROOT, profile)}). Read-only: analytics and profile pages only. No likes, follows, posts or settings changes.${need.length ? ` Needs sign-in as his own account: ${need.join(', ')}. Sign in from Slack with "open browser".` : ''}`);
  L.push('', `## X (${x.handle})`);
  if (x.signedIn !== true) {
    L.push(x.signedIn === false ? '- Not signed in in the AaaS browser profile.' : `- Signed in as ${x.viewer ? '@' + x.viewer : 'another account'}, not ${x.handle}.`);
    L.push(`- Followers (public profile): ${v(x.followers)}${x.following != null ? ` (following ${v(x.following)}${x.posts != null ? `, posts ${v(x.posts)}` : ''})` : ''}.`);
    L.push('- Verified followers: missing (Overview not read for this account).');
  } else {
    L.push(`- Followers: ${v(x.followers)}${x.following != null ? ` (following ${v(x.following)}${x.posts != null ? `, posts ${v(x.posts)}` : ''})` : ''}.`);
    L.push(`- Verified followers: ${x.verified != null ? `${v(x.verified)} of ${v(x.verifiedTotal)}` : 'missing (' + (x.notes.find((n) => /Verified/.test(n)) || 'not shown') + ')'}`);
    L.push(`- Impressions (Overview${x.overviewRange ? ', ' + x.overviewRange : ''}): ${v(x.impressions)}; engagements: ${v(x.engagements)}.`);
    L.push(`- Content tab rows with a date: ${x.contentRows == null ? 'not read' : x.contentRows}.`);
  }
  L.push('', `## LinkedIn (${li.handle})`);
  if (li.signedIn !== true) L.push(li.signedIn === false ? '- Not signed in in the AaaS browser profile. No numbers read.' : `- Signed in as another LinkedIn account, not ${li.handle}. No numbers read (that account's analytics are not his).`);
  else L.push(`- Followers: ${v(li.followers)}.`, `- Impressions${li.impressionsRange ? ' (' + li.impressionsRange.toLowerCase() + ')' : ''}: ${v(li.impressions)}.`);
  L.push('', `## Facebook (${fb.handle})`);
  if (fb.signedIn === false) L.push('- Not signed in in the AaaS browser profile. No numbers read.');
  else if (fb.signedIn === 'other') L.push('- Signed in as a different Facebook account.', `- Followers (public profile): ${fb.followersText ? fb.followersText + ' (as shown)' : 'not found'}.`, '- Reach: not read (needs his own account).');
  else L.push(`- Followers: ${fb.followersText ? fb.followersText + ' (as shown)' : 'not found'}.`, `- Reach${fb.reachRange ? ' (' + fb.reachRange.toLowerCase() + ')' : ''}: ${v(fb.reach)}.`);
  const notes = res.flatMap((s) => s.notes.map((n) => `${s.site}: ${n}`));
  if (notes.length) { L.push('', '## Notes'); notes.forEach((n) => L.push('- ' + n)); }
  L.push('', '## Source', `- AaaS browser (Chrome, saved sign-ins), screenshots in ${path.relative(OUT, SHOTS)}/:`);
  res.flatMap((s) => s.shots).forEach((p) => L.push('  - ' + path.basename(p)));
  return L.join('\n') + '\n';
}

function writeOutputs(res, t0, t1) {
  const file = path.join(OUT, `analytics-${DATE}.md`);
  const md = report(res, t0, t1);
  const SEP = '\n---\n\n## AaaS browser snapshot\n';
  const section = SEP + md.replace(/^# .*\n/, '').replace(/^## /gm, '### ');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!cur || /^# .*\nSnapshot .*npm run social:snapshot/.test(cur)) fs.writeFileSync(file, md); // ours alone: replace
  else fs.writeFileSync(file, (cur.includes(SEP) ? cur.slice(0, cur.indexOf(SEP)) : cur.replace(/\n+$/, '\n')) + section); // keep the other routine's report, replace only our section
  const x = res[0];
  const tsv = path.join(OUT, 'x-verified-followers.tsv');
  if (x.followers != null) {
    const row = [DATE, x.followers, x.verified ?? '', `aidentify-browser (X ${x.verified != null ? 'Overview' : x.signedIn === true ? 'profile; verified not shown on Overview' : 'public profile; browser signed in as ' + (x.viewer ? '@' + x.viewer : 'another account') + ', verified not read'} at ~${hm(t0)} IST)`].join('\t');
    const lines = fs.existsSync(tsv) ? fs.readFileSync(tsv, 'utf8').split('\n').filter((l) => l && !(l.startsWith(DATE + '\t') && l.includes('aidentify-browser'))) : [];
    fs.writeFileSync(tsv, lines.concat(row).join('\n') + '\n');
  }
  return file;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  let b = await openBrowser();
  if (b.busy && !flag('no-retry')) {
    log(`browser busy: ${b.busy}. Retrying once in ${RETRY_MIN} min.`);
    await new Promise((r) => setTimeout(r, RETRY_MIN * 60000));
    b = await openBrowser();
  }
  if (b.busy) { log(`STATUS browser busy: ${b.busy}. Nothing written.`); return 2; }
  const t0 = now(); log('reading X, LinkedIn, Facebook (read-only)');
  const res = [];
  try {
    for (const fn of [readX, readLinkedIn, readFacebook]) {
      try { res.push(await fn(b.ctx)); }
      catch (e) { res.push({ site: fn.name.slice(4), handle: '', signedIn: null, shots: [], notes: ['error: ' + e.message.split('\n')[0]] }); }
    }
  } finally { await b.ctx.close().catch(() => {}); releaseProfileLock(profile); }
  const t1 = now();
  const file = writeOutputs(res, t0, t1);
  const need = res.filter((s) => s.signedIn !== true).map((s) => `${s.site}${s.signedIn === 'other' ? ' (wrong account' + (s.viewer ? ': ' + s.viewer : '') + ')' : s.signedIn === false ? ' (not signed in)' : ' (unreadable)'}`);
  const partial = res.some((s) => s.signedIn !== true || s.followers == null);
  log(`report: ${file}`);
  log(`X followers ${v(res[0].followers)}, verified ${v(res[0].verified)} | LinkedIn followers ${res[1].signedIn === true ? v(res[1].followers) : 'not read'} | Facebook followers ${v(res[2].followersText)}, reach ${res[2].signedIn === true ? v(res[2].reach) : 'not read'}`);
  log(`STATUS ${partial ? 'partial' : 'ok'}${need.length ? '; needs sign-in: ' + need.join(', ') : ''}; took ${Math.round((t1 - t0) / 1000)}s`);
  return partial ? 3 : 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error('STATUS error:', e.message.split('\n')[0]); releaseProfileLock(profile); process.exit(1); });
