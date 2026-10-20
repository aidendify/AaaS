/* Shared behaviour for /v2 and /white-label. Business types match lib/waitlist.js. */
const BUSINESS_TYPES = ['Clinic: skin / aesthetic / hair', 'Clinic: dental', 'Clinic: physio / wellness / other', 'Coach / trainer', 'Consultant / freelancer', 'Course creator / online educator', 'Coaching institute / tuition', 'Real estate broker / agent', 'Interior designer / home services', 'Salon / spa', 'Gym / fitness studio', 'Travel agency', 'Digital marketing agency', 'Email / performance marketer', 'Other'];

const $ = (s, r = document) => r.querySelector(s);
const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>';

function paintTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const btn = $('#themeBtn');
  if (btn) {
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#12110f' : '#f3efe6';
}
paintTheme();
const themeBtn = $('#themeBtn');
if (themeBtn) themeBtn.onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('as_theme', next); } catch (e) { /* private mode */ }
  paintTheme();
};

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  const id = tab.getAttribute('aria-controls');
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    if (panel) panel.hidden = !on;
  });
  tab.focus();
}
tabs.forEach((tab, i) => {
  tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
    selectTab(next);
  });
});

const f = $('#join-form');
if (f) {
  const sel = f.businessType;
  const pre = f.dataset.preselect || '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose one';
  sel.replaceChildren(placeholder);
  for (const t of BUSINESS_TYPES) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = pre && BUSINESS_TYPES.includes(pre) ? pre : '';
  const other = $('#otherWrap');
  sel.onchange = () => { if (other) other.hidden = sel.value !== 'Other'; };
  if (other) other.hidden = sel.value !== 'Other';

  const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/i;
  function setErr(k, m) {
    const el = document.querySelector('[data-for="' + k + '"]');
    if (el) el.textContent = m || '';
    const inp = f.elements[k];
    if (inp && inp.setAttribute) inp.setAttribute('aria-invalid', m ? 'true' : 'false');
  }
  function check() {
    const e = {};
    const v = (n) => String(f.elements[n].value || '').trim();
    if (v('name').length < 2) e.name = 'Enter your name.';
    if (!EMAIL.test(v('email')) || v('email').length > 120 || v('email').includes('..')) e.email = 'Enter a valid email address, like you@business.com.';
    const digits = v('whatsapp').replace(/\D/g, '');
    const own = /^\s*(\+|00)/.test(v('whatsapp'));
    if (own ? (digits.length < 8 || digits.length > 15) : (digits.length < 10 || digits.length > 15)) e.whatsapp = 'Enter a WhatsApp number: 10 digits for India, or +country code and number.';
    if (!v('businessType')) e.businessType = 'Choose your business type.';
    if (v('city').length < 2) e.city = 'Enter your city.';
    if (!f.consent.checked) e.consent = 'Tick the box so we can message you on WhatsApp.';
    return e;
  }
  f.addEventListener('input', (ev) => { if (ev.target.name) setErr(ev.target.name === 'businessOther' ? 'businessType' : ev.target.name, ''); });
  const b = $('#join-btn');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    document.querySelectorAll('.err').forEach((x) => { x.textContent = ''; });
    f.querySelectorAll('[aria-invalid]').forEach((x) => x.setAttribute('aria-invalid', 'false'));
    const bad = check();
    if (Object.keys(bad).length) {
      for (const [k, m] of Object.entries(bad)) setErr(k, m);
      const first = f.elements[Object.keys(bad)[0]];
      if (first && first.focus) first.focus();
      return;
    }
    b.disabled = true;
    b.innerHTML = '<span class="spin" aria-hidden="true"></span> Saving…';
    const d = Object.fromEntries(new FormData(f));
    d.consent = f.consent.checked;
    const qs = new URLSearchParams(location.search);
    d.source = qs.get('utm_source') || qs.get('ref') || f.dataset.source || '';
    try {
      const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        f.hidden = true;
        const ok = $('#join-ok');
        ok.hidden = false;
        const who = String(d.name || '').trim().split(' ')[0];
        $('#join-ok-p').textContent = j.again
          ? 'You were already on the list, so we updated your details. We\'ll reach out on WhatsApp and email soon.'
          : 'Thanks, ' + who + '! We\'ll reach out on WhatsApp and email when your early-access spot opens.';
        b.disabled = false;
        b.textContent = 'Join the waitlist';
        ok.focus();
        return;
      }
      if (j.fields) for (const [k, v] of Object.entries(j.fields)) setErr(k, v);
      else $('#join-gerr').textContent = r.status === 429 ? 'Too many tries. Please wait a minute and try again.' : (j.message || 'Something went wrong. Please try again.');
    } catch (x) {
      $('#join-gerr').textContent = 'No connection. Please try again.';
    }
    b.disabled = false;
    b.textContent = 'Join the waitlist';
  };
  const again = $('#join-again');
  if (again) again.onclick = () => { $('#join-ok').hidden = true; f.hidden = false; f.name.focus(); };
}

document.querySelectorAll('.mob a').forEach((a) => a.addEventListener('click', () => { const d = a.closest('details'); if (d) d.open = false; }));

document.querySelectorAll('[data-join]').forEach((a) => a.addEventListener('click', (e) => {
  const join = $('#join');
  if (!join) return;
  e.preventDefault();
  join.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const name = f && f.name;
  if (name) setTimeout(() => name.focus({ preventScroll: true }), 400);
}));
