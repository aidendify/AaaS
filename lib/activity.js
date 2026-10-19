// Agent activity: a live record of each chat run (so the page can show steps while the agent works)
// and a short history per agent (status, last run, recent steps, recent errors). Stored per customer only.
const RUN_TTL = 10 * 60 * 1000, KEEP_RUNS = 10, KEEP_ERR = 5;
const parse = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };
const clip = (s, n) => String(s || '').slice(0, n);
const cleanRid = (r) => /^[a-z0-9-]{6,40}$/i.test(String(r || '')) ? String(r) : '';
const safeErr = (e) => e && (e.status === 429 ? 'Hit today’s AI limit' : e.code === 'ai_timeout' ? 'Took too long and stopped' : 'Something went wrong; the answer used the simple mode');

export function startRun(st, email, { rid, agent, now = Date.now } = {}) {
  const id = cleanRid(rid), aid = agent ? agent.id : 'assistant', t0 = now(), steps = [];
  let last = 0, pending = null;
  const save = (status) => id ? st.put('as_run:' + email + ':' + id, JSON.stringify({ id, aid, status, steps, at: t0, ms: now() - t0 }), now()) : null;
  if (id) pending = save('running');
  return {
    step(s) {
      steps.push({ k: clip(s && s.k, 20), t: clip(s && s.t, 120) });
      if (id && now() - last > 400) { last = now(); pending = Promise.resolve(pending).then(() => save('running')).catch(() => {}); }
    },
    async done(status, outSteps, approvals, err) {
      try { await pending; } catch { /* ignore */ }
      const ms = now() - t0, st8 = status === 'ok' && (approvals || []).some((a) => a && a.status === 'pending') ? 'waiting' : status;
      const fin = (outSteps || steps).slice(0, 12).map((s) => ({ k: clip(s.k, 20), t: clip(s.t, 120) }));
      try {
        if (id) await st.put('as_run:' + email + ':' + id, JSON.stringify({ id, aid, status: st8, steps: fin, at: t0, ms }), now());
        const all = parse((await st.get('as_act:' + email))?.v, {}) || {};
        const a = all[aid] || { runs: [], errors: [] };
        a.runs = [{ at: t0, ms, status: st8, steps: fin }, ...(a.runs || [])].slice(0, KEEP_RUNS);
        if (status === 'error') a.errors = [{ at: t0, msg: safeErr(err) }, ...(a.errors || [])].slice(0, KEEP_ERR);
        all[aid] = a; await st.put('as_act:' + email, JSON.stringify(all), now());
      } catch (e) { console.error('activity', e.message); }
    },
  };
}

export async function getRun(st, email, rid, now = Date.now()) {
  const id = cleanRid(rid); if (!id) return null;
  const r = parse((await st.get('as_run:' + email + ':' + id))?.v, null);
  return r && now - r.at < RUN_TTL ? r : null;
}

// one row per agent: status (idle / working / waiting for approval / error), last run, steps, errors, routines
export async function agentStatus(st, email, data, routines, now = Date.now()) {
  const all = parse((await st.get('as_act:' + email))?.v, {}) || {};
  const rts = (Array.isArray(routines) ? routines : []).filter((r) => r && r.on);
  const row = (id, name, kind) => {
    const a = all[id] || { runs: [], errors: [] }, last = (a.runs || [])[0] || null;
    const err = (a.errors || [])[0];
    const status = !last ? 'idle' : last.status === 'error' ? 'error' : last.status === 'waiting' ? 'waiting' : 'idle';
    const mine = rts.filter((r) => String(r.aid ?? r.agent_id ?? 'assistant') === String(id));
    return { id, name, kind, status, last: last ? { at: last.at, ms: last.ms, status: last.status, steps: last.steps } : null,
      runs: (a.runs || []).length, errors: a.errors || [], lastError: err || null,
      routines: mine.map((r) => ({ id: r.id, title: clip(r.title, 80), next: r.next || null, paused: !!r.paused })) };
  };
  const agents = ((data && data.agents) || []).filter((a) => a && !a._new).map((a) => row(a.id, a.name, a.kind));
  return { agents: [row('assistant', 'Chief of Staff', 'assistant'), ...agents], at: now };
}
