// Clinic software connectors. Nothing here sends email, SMS, a paid WhatsApp message, or a payment.
// Credentials are read from the environment at call time and are never written to the account or to git.
//
// Eka.care public docs (production host https://api.eka.care):
//   Login:       POST /connect-auth/v1/account/login   { client_id, client_secret }
//                https://developer.eka.care/api-reference/authorization/client-login
//   Directory:   GET  /profiles/v1/patient/minified/?page=&pageSize=
//                Authorization: Bearer <access_token>, header client-id
//                https://developer.eka.care/api-reference/doc-tool/patient-directory-apis/patients-list-minified
//   One patient: GET  /dr/v1/patient/{patient_id}      header auth: <access_token>
//                https://developer.eka.care/api-reference/doc-tool/patient-registration-api/get-patient-details-by-id
//   Visits:      GET  /dr/v1/appointment?start_date=&end_date=   (range at most 7 days)
//                header auth: <access_token>
//                https://developer.eka.care/api-reference/doc-tool/appointment-api/get-appointments-by-date
// Clinical fields (prescriptions, addresses, notes) are dropped on purpose.

export const EKA_SOURCE = 'Eka.care';
export const OTHER_SOURCE = 'Clinic software';
const EKA_DOCS = 'https://developer.eka.care/api-reference/authorization/client-login';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function isConnectorSource(source) {
  return source === EKA_SOURCE || source === OTHER_SOURCE;
}

export function ekaConfig(env = process.env) {
  const clientId = String(env.EKA_CLIENT_ID || '').trim();
  const clientSecret = String(env.EKA_CLIENT_SECRET || '').trim();
  const base = String(env.EKA_BASE_URL || 'https://api.eka.care').replace(/\/+$/, '');
  const clinicId = String(env.EKA_CLINIC_ID || '').trim();
  return { clientId, clientSecret, base, clinicId, configured: !!(clientId && clientSecret) };
}

export function ekaConnection(c, env = process.env) {
  const cfg = ekaConfig(env);
  const base = {
    id: 'eka', name: 'Eka.care', docs: EKA_DOCS,
  };
  if (c && c.demo) {
    return { ...base, status: 'demo', label: 'Connected (demo)', detail: 'Sample data only. Sync does not call Eka.care. On a real server, set EKA_CLIENT_ID and EKA_CLIENT_SECRET. Those values stay in the environment.' };
  }
  if (cfg.configured) {
    return { ...base, status: 'ready', label: 'Connected', detail: 'Server credentials are set. Sync reads the patient directory and the last 7 days of appointments. Nothing is written back to Eka.care, and the tokens are not saved.' };
  }
  return { ...base, status: 'needs_credentials', label: 'Available, connect with credentials', detail: 'Available, connect with credentials. Set EKA_CLIENT_ID and EKA_CLIENT_SECRET on the server. Optional: EKA_BASE_URL (default https://api.eka.care) and EKA_CLINIC_ID. Until then, use CSV or the other-software webhook.' };
}

export function otherConnection(c, env = process.env) {
  const on = !!String(env.CLINIC_CONNECTOR_WEBHOOK_SECRET || '').trim();
  const path = c && c.formToken ? '/api/clinic/connectors/webhook/' + c.formToken : '';
  return {
    id: 'other', name: 'Other clinic software', status: 'ready', label: 'Ready', url: path,
    detail: on
      ? 'CSV import is on. The webhook is on for this form token. Send JSON or a csv field with header X-AaaS-Connector-Secret. The secret stays in the server environment.'
      : 'CSV import works today. A webhook stays closed until CLINIC_CONNECTOR_WEBHOOK_SECRET is set on the server. The path is /api/clinic/connectors/webhook/<form token>.',
  };
}

export function softwareStats(patients, invoices, paidThisMonth, totalOf) {
  const people = (patients || []).filter((p) => p && isConnectorSource(p.source));
  const backIds = new Set(people.filter((p) => p.broughtBack).map((p) => p.id));
  const broughtBackInr = (invoices || [])
    .filter((inv) => inv && inv.status === 'paid' && backIds.has(inv.patientId) && paidThisMonth(inv))
    .reduce((s, inv) => s + totalOf(inv), 0);
  return {
    fromSoftware: people.length,
    fromSoftwareNames: people.slice(0, 12).map((p) => ({ name: p.name, source: p.source, broughtBack: !!p.broughtBack })),
    broughtBackInr,
    broughtBackNames: people.filter((p) => p.broughtBack).map((p) => p.name),
  };
}

const DONE = new Set(['CM', 'CMNP']);
const MISSED = new Set(['NS', 'NSD', 'NSS', 'AB']);
const CANCEL = new Set(['CN', 'CND', 'CNS', 'PC', 'PNR', 'RE', 'RES', 'RED']);

export function ekaAppointmentStatus(code) {
  const s = String(code || '').toUpperCase();
  if (DONE.has(s)) return 'completed';
  if (MISSED.has(s)) return 'noshow';
  if (CANCEL.has(s)) return 'cancelled';
  if (['BOOKED', 'COMPLETED', 'NOSHOW', 'CANCELLED'].includes(s.toLowerCase()) || ['booked', 'completed', 'noshow', 'cancelled'].includes(String(code || '').toLowerCase())) return String(code).toLowerCase();
  return 'booked';
}

function istDay(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function mapProfile(p) {
  const name = clip(p && (p.fln || p.username), 80);
  if (name.length < 2) return null;
  const last = Number(p.u_ate);
  return {
    type: 'patient', name, phone: clip(p.mobile, 24), email: '',
    last_visit: Number.isFinite(last) && last > 0 ? new Date(last * 1000).toISOString() : '',
    value: '', external_id: clip(p.oid, 80),
  };
}

function mapDetail(p) {
  const name = clip([p && p.first_name, p && p.middle_name, p && p.last_name].filter(Boolean).join(' '), 80);
  if (name.length < 2) return null;
  const created = Number(p.created_at);
  return {
    type: 'patient', name, phone: clip(p.mobile, 24), email: clip(p.email, 200),
    last_visit: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : '',
    value: '', external_id: clip(p.patient_id, 80),
  };
}

function mapAppt(a, byExternal) {
  const person = byExternal.get(String(a.patient_id || ''));
  if (!person) return null;
  const start = Number(a.start_time);
  if (!Number.isFinite(start) || start <= 0) return null;
  return {
    type: 'appointment', name: person.name, phone: person.phone || '',
    when: new Date(start * 1000).toISOString(), service: 'Visit', status: ekaAppointmentStatus(a.status),
    fee: 0, external_id: clip(a.appointment_id, 80),
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function ekaCall(fetchImpl, url, opts) {
  let res;
  try {
    res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw Object.assign(new Error('Eka.care did not answer in time.'), { status: 504 });
    throw Object.assign(new Error('Eka.care could not be reached.'), { status: 502 });
  }
  const data = await readJson(res);
  if (!res.ok) throw Object.assign(new Error('Eka.care returned HTTP ' + res.status + '.'), { status: res.status });
  return data;
}

// Adapter: pull() returns normalised rows. The access token lives only in this call.
export async function pullEka(env = process.env, fetchImpl = globalThis.fetch, now = Date.now()) {
  const cfg = ekaConfig(env);
  if (!cfg.configured) throw Object.assign(new Error('Set EKA_CLIENT_ID and EKA_CLIENT_SECRET on the server.'), { status: 400 });
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('This server cannot call Eka.care.'), { status: 500 });
  const login = await ekaCall(fetchImpl, cfg.base + '/connect-auth/v1/account/login', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const token = String(login.access_token || '');
  if (!token) throw Object.assign(new Error('Eka.care login did not return an access token.'), { status: 502 });
  const patients = [];
  let page = 1;
  for (let i = 0; i < 5; i++) {
    const data = await ekaCall(fetchImpl, cfg.base + '/profiles/v1/patient/minified/?page=' + page + '&pageSize=200&select=u_ate', {
      method: 'GET', headers: { authorization: 'Bearer ' + token, 'client-id': cfg.clientId, accept: 'application/json' },
    });
    for (const row of data.profiles || []) {
      const mapped = mapProfile(row);
      if (mapped) patients.push(mapped);
    }
    const next = data.currPageMeta && Number(data.currPageMeta.nextPage);
    if (!next || next === page) break;
    page = next;
  }
  const end = istDay(now);
  const start = shiftDay(end, -6);
  const q = new URLSearchParams({ start_date: start, end_date: end, page_no: '0' });
  if (cfg.clinicId) q.set('clinic_id', cfg.clinicId);
  const visits = await ekaCall(fetchImpl, cfg.base + '/dr/v1/appointment?' + q.toString(), {
    method: 'GET', headers: { auth: token, authorization: 'Bearer ' + token, accept: 'application/json' },
  });
  const byExternal = new Map(patients.filter((p) => p.external_id).map((p) => [p.external_id, p]));
  const missing = [];
  for (const a of visits.appointments || []) {
    const id = String(a.patient_id || '');
    if (id && !byExternal.has(id) && missing.length < 30 && !missing.includes(id)) missing.push(id);
  }
  for (const id of missing) {
    const detail = await ekaCall(fetchImpl, cfg.base + '/dr/v1/patient/' + encodeURIComponent(id), {
      method: 'GET', headers: { auth: token, authorization: 'Bearer ' + token, accept: 'application/json' },
    });
    const mapped = mapDetail(detail);
    if (mapped) { patients.push(mapped); byExternal.set(mapped.external_id || id, mapped); }
  }
  const appointments = [];
  for (const a of visits.appointments || []) {
    const mapped = mapAppt(a, byExternal);
    if (mapped) appointments.push(mapped);
  }
  return { patients, appointments, calledNetwork: true };
}

export function rowsFromWebhook(body) {
  const src = body && typeof body === 'object' ? body : {};
  const patients = Array.isArray(src.patients) ? src.patients : [];
  const appointments = Array.isArray(src.appointments) ? src.appointments : [];
  const rows = [];
  for (const p of patients.slice(0, 2000)) {
    rows.push({
      type: 'patient', name: p && (p.name || p.patient), phone: p && (p.phone || p.mobile), email: p && p.email,
      last_visit: p && (p.last_visit || p.lastVisit), value: p && p.value, external_id: p && (p.external_id || p.id),
    });
  }
  for (const a of appointments.slice(0, 2000)) {
    const status = ekaAppointmentStatus(a && a.status);
    rows.push({
      type: 'appointment', name: a && (a.name || a.patient), phone: a && a.phone,
      when: a && (a.when || a.start), service: (a && a.service) || 'Visit', status, fee: a && a.fee,
      external_id: a && (a.external_id || a.id),
    });
  }
  if (!rows.length) throw Object.assign(new Error('Send patients, appointments, or a csv field.'), { status: 400 });
  return rows;
}
