// src/pages/admin.tsx — ops console over /api/brief
//
// Two tabs:
//   Run     — run a mode (Pool / Route / Full), read per-step logs, inspect output.
//   History — saved runs from Supabase (7-day / month), window cost total, and
//             per-run drill-down into per-step cost + logs.
// Utilitarian by intent.

import { useState, useEffect } from 'react';
import type { Edition } from '@/lib/brief/types';

type StepLog = { name: string; ok: boolean; ms: number; error?: string; cost_usd?: number; tokens_in?: number; tokens_out?: number; logs: string[] };
type ApiResult = { mode: string; date: string; edition?: Edition; error?: string; runId?: string; steps?: StepLog[]; poolSize?: number; pool?: any[]; briefs?: any[] };

const RCA_KEEP = /\b(fail|error|warn|fallback|short|blocked|notfound|neterr|ratelimit|reachability|assembled|used events|unique events|below floor|ceiling|written|merged)\b|→|->/i;
const usd = (n: any) => '$' + (Number(n) || 0).toFixed(4);
const when = (s: string) => { try { return new Date(s).toLocaleString(); } catch { return s; } };

const S: Record<string, React.CSSProperties> = {
  box:  { border: '1px solid #ddd', borderRadius: 6, padding: '8px 10px', margin: '6px 0', background: '#fff' },
  pre:  { background: '#0b0b0b', color: '#d6d6d6', padding: 10, borderRadius: 6, overflow: 'auto', fontSize: 12, maxHeight: 340, whiteSpace: 'pre-wrap', margin: '6px 0 0' },
  btn:  { padding: '6px 12px', marginRight: 8, marginBottom: 6, cursor: 'pointer', border: '1px solid #bbb', borderRadius: 6, background: '#f7f7f7' },
  chip: { display: 'inline-block', background: '#eef', borderRadius: 10, padding: '1px 8px', margin: 2, fontSize: 12 },
  head: { cursor: 'pointer', fontFamily: 'ui-monospace, monospace', fontSize: 13 },
  tab:  { padding: '6px 16px', marginRight: 6, cursor: 'pointer', border: '1px solid #bbb', borderBottom: 'none', borderRadius: '6px 6px 0 0', background: '#eee' },
  tabOn:{ padding: '6px 16px', marginRight: 6, cursor: 'pointer', border: '1px solid #bbb', borderBottom: '2px solid #fff', borderRadius: '6px 6px 0 0', background: '#fff', fontWeight: 600 },
};

export default function Admin() {
  const [view, setView] = useState<'run' | 'history'>('run');
  return (
    <div style={{ maxWidth: 900, margin: '20px auto', padding: '0 14px', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 10px' }}>Brief pipeline console</h2>
      <div style={{ borderBottom: '1px solid #bbb', marginBottom: 12 }}>
        <span style={view === 'run' ? S.tabOn : S.tab} onClick={() => setView('run')}>Run</span>
        <span style={view === 'history' ? S.tabOn : S.tab} onClick={() => setView('history')}>History</span>
      </div>
      {view === 'run' ? <Console /> : <History />}
    </div>
  );
}

// ─── Run tab ─────────────────────────────────────────────────────────────────
function Console() {
  const [date, setDate] = useState('');
  const [edition, setEdition] = useState<Edition>('10min');
  const [selText, setSelText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<ApiResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  async function run(mode: string) {
    setBusy(mode); setErr(null);
    let selections: any;
    if (selText.trim()) { try { selections = JSON.parse(selText); } catch { setErr('selections JSON invalid'); setBusy(null); return; } }
    try {
      const r = await fetch(`/api/brief?mode=${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, edition, date: date || undefined, selections }) });
      const j: ApiResult = await r.json();
      if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
      setRes(j);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(null); }
  }
  const digest = (steps: StepLog[] = []) => steps.flatMap((s) => [`— ${s.name} ${s.ok ? 'ok' : 'FAIL'} ${s.ms}ms${s.error ? ' :: ' + s.error : ''}`, ...s.logs.filter((l) => RCA_KEEP.test(l))]).join('\n');
  const copy = (t: string) => { try { navigator.clipboard?.writeText(t); } catch { /* noop */ } };
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <>
      <div style={S.box}>
        <label>date&nbsp;<input value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD (today)" style={{ padding: 4 }} /></label>
        &nbsp;&nbsp;
        <label>edition&nbsp;<select value={edition} onChange={(e) => setEdition(e.target.value as Edition)} style={{ padding: 4 }}><option value="5min">5min</option><option value="10min">10min</option><option value="deep">deep</option></select></label>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>selections JSON (blank → use profiles)</summary>
          <textarea value={selText} onChange={(e) => setSelText(e.target.value)} rows={5} spellCheck={false} placeholder='[{"userId":"u1","cities":["Bengaluru"],"interests":["Markets & Investing","Sport"],"industries":[]}]' style={{ width: '100%', marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
        </details>
      </div>
      <div style={{ margin: '10px 0' }}>
        {(['fetch', 'route', 'full'] as const).map((m) => (
          <button key={m} style={S.btn} disabled={!!busy} onClick={() => run(m)}>{busy === m ? '…running' : m === 'fetch' ? 'Pool (fetch+dedupe)' : m === 'route' ? 'Route' : 'Full run'}</button>
        ))}
      </div>
      {err && <div style={{ ...S.box, color: 'crimson' }}>error: {err}</div>}
      {res && (
        <>
          <h3 style={{ margin: '14px 0 4px' }}>Steps</h3>
          {(res.steps || []).map((s) => (
            <div key={s.name} style={S.box}>
              <div style={S.head} onClick={() => toggle(s.name)}>
                <span style={{ color: s.ok ? 'green' : 'crimson' }}>{s.ok ? '●' : '✕'}</span>{' '}
                {s.name} · {s.ms}ms{s.cost_usd ? ` · ${usd(s.cost_usd)}` : ''}{s.error ? ` · ${s.error}` : ''} · {s.logs.length} lines {open[s.name] ? '▾' : '▸'}
              </div>
              {open[s.name] && <pre style={S.pre}>{s.logs.join('\n') || '(no output)'}</pre>}
            </div>
          ))}
          <h3 style={{ margin: '14px 0 4px' }}>Output · {res.mode}{res.runId ? ` · saved ${res.runId.slice(0, 8)}` : ''}</h3>
          {res.mode === 'fetch' && <PoolView pool={res.pool} size={res.poolSize} />}
          {res.mode === 'route' && <RouteView briefs={res.briefs} />}
          {res.mode === 'full' && <FullView briefs={res.briefs} open={open} toggle={toggle} />}
          <h3 style={{ margin: '14px 0 4px' }}>Export</h3>
          <button style={S.btn} onClick={() => copy(digest(res.steps))}>Copy RCA digest</button>
          <button style={S.btn} onClick={() => copy((res.steps || []).flatMap((s) => s.logs).join('\n'))}>Copy full logs</button>
          <button style={S.btn} onClick={() => copy(JSON.stringify(res, null, 2))}>Copy raw JSON</button>
        </>
      )}
    </>
  );
}

// ─── History tab ─────────────────────────────────────────────────────────────
function History() {
  const [win, setWin] = useState<'7d' | 'month'>('7d');
  const [runs, setRuns] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openStep, setOpenStep] = useState<Record<string, boolean>>({});

  async function load(w: string) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/brief?mode=history&window=${w}`);
      const j = await r.json();
      if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
      setRuns(j.runs || []);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { load(win); }, [win]);

  async function expand(id: string) {
    setOpen((o) => ({ ...o, [id]: !o[id] }));
    if (!detail[id]) {
      try {
        const r = await fetch(`/api/brief?mode=run&id=${id}`);
        const j = await r.json();
        setDetail((d) => ({ ...d, [id]: j.run || {} }));
      } catch { setDetail((d) => ({ ...d, [id]: {} })); }
    }
  }

  const total = (runs || []).reduce((n, r) => n + (Number(r.total_cost_usd) || 0), 0);

  return (
    <>
      <div style={{ margin: '4px 0 10px' }}>
        {(['7d', 'month'] as const).map((w) => (
          <button key={w} style={{ ...S.btn, background: win === w ? '#e7efff' : '#f7f7f7', fontWeight: win === w ? 600 : 400 }} onClick={() => setWin(w)}>{w === '7d' ? 'Last 7 days' : 'This month'}</button>
        ))}
        <button style={S.btn} disabled={busy} onClick={() => load(win)}>{busy ? '…' : '↻ refresh'}</button>
      </div>
      {err && <div style={{ ...S.box, color: 'crimson' }}>error: {err} — check the run saved (Supabase write access) and the client export.</div>}
      {runs && (
        <div style={{ ...S.box, background: '#f4f8ff' }}>
          <b>{runs.length}</b> run{runs.length === 1 ? '' : 's'} · window total <b>{usd(total)}</b>
        </div>
      )}
      {runs && runs.length === 0 && <div style={S.box}>No saved runs in this window. Run a Full run first (and confirm it wrote to brief_runs).</div>}
      {(runs || []).map((r) => {
        const d = detail[r.id] || {};
        const steps: StepLog[] = d.steps || [];
        const meta = d.meta || {};
        return (
          <div key={r.id} style={S.box}>
            <div style={S.head} onClick={() => expand(r.id)}>
              <span style={{ color: r.ok ? 'green' : 'crimson' }}>{r.ok ? '●' : '✕'}</span>{' '}
              {when(r.created_at)} · {r.mode}{r.edition ? `/${r.edition}` : ''} · <b>{usd(r.total_cost_usd)}</b> {open[r.id] ? '▾' : '▸'}
            </div>
            {open[r.id] && (
              <div style={{ marginTop: 6 }}>
                {(meta.user_count != null || meta.pool_size != null) && (
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>users {meta.user_count ?? '–'} · pool {meta.pool_size ?? '–'}</div>
                )}
                {steps.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>loading detail… (empty = the run stored no steps)</div>}
                {steps.map((s) => {
                  const k = `${r.id}:${s.name}`;
                  return (
                    <div key={k} style={{ borderTop: '1px solid #eee', padding: '4px 0' }}>
                      <div style={S.head} onClick={() => setOpenStep((o) => ({ ...o, [k]: !o[k] }))}>
                        <span style={{ color: s.ok ? 'green' : 'crimson' }}>{s.ok ? '●' : '✕'}</span>{' '}
                        {s.name} · {s.ms}ms · <b>{usd(s.cost_usd)}</b> · {(s.tokens_in || 0) + (s.tokens_out || 0)} tok {openStep[k] ? '▾' : '▸'}
                      </div>
                      {openStep[k] && <pre style={S.pre}>{(s.logs || []).join('\n') || '(no output)'}</pre>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ─── shared output views ─────────────────────────────────────────────────────
function PoolView({ pool, size }: { pool?: any[]; size?: number }) {
  if (!pool) return <div style={S.box}>pool size: {size ?? 0} (add <code>&full=1</code> for the full pool)</div>;
  const top = pool.slice(0, 40);
  return (
    <div style={S.box}>
      <div style={{ marginBottom: 6 }}>{size ?? pool.length} unique events · showing {top.length}</div>
      {top.map((s: any) => (
        <div key={s.eventId} style={{ borderTop: '1px solid #eee', padding: '4px 0', fontSize: 13 }}>
          <b>nw {s.nw ?? '–'}</b> · {s.headline}
          <div>{(s.candidateSections || []).map((c: string) => <span key={c} style={S.chip}>{c}</span>)}</div>
        </div>
      ))}
    </div>
  );
}
function RouteView({ briefs }: { briefs?: any[] }) {
  if (!briefs?.length) return <div style={S.box}>no briefs</div>;
  return (
    <div style={S.box}>
      {briefs.map((b: any) => (
        <div key={b.userId} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
          <div style={{ fontSize: 13 }}><b>{b.userId}</b> · total {b.total} · {b.ceilingReached ? 'ceiling' : 'below ceiling'}</div>
          <div>{(b.sections || []).map((s: any) => <span key={s.key} style={{ ...S.chip, background: s.kind === 'core' ? '#efe' : '#eef' }}>{s.key}:{s.count}</span>)}</div>
        </div>
      ))}
    </div>
  );
}
function FullView({ briefs, open, toggle }: { briefs?: any[]; open: Record<string, boolean>; toggle: (k: string) => void }) {
  if (!briefs?.length) return <div style={S.box}>no briefs</div>;
  return (
    <>
      {briefs.map((b: any) => {
        const total = (b.sections || []).reduce((n: number, s: any) => n + (s.stories?.length || 0), 0);
        const key = `full:${b.userId}`;
        return (
          <div key={b.userId} style={S.box}>
            <div style={S.head} onClick={() => toggle(key)}><b>{b.userId}</b> · {b.edition} · {total} stories · {(b.sections || []).length} sections {open[key] ? '▾' : '▸'}</div>
            {open[key] && (b.sections || []).map((sec: any) => (
              <div key={sec.key} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
                <div style={{ fontSize: 13 }}><b>{sec.label}</b> <span style={{ color: '#888' }}>({sec.kind}, {sec.stories?.length || 0})</span></div>
                {sec.why_it_matters && <div style={{ fontSize: 12, fontStyle: 'italic', color: '#556', margin: '2px 0 4px' }}>{sec.why_it_matters}</div>}
                {(sec.stories || []).map((st: any) => <div key={st.eventId} style={{ fontSize: 12, padding: '2px 0' }}>• {st.headline} {st.hook ? <span style={{ color: '#777' }}>— {st.hook}</span> : ''}</div>)}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
