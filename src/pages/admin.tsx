// src/pages/admin.tsx — lean ops console over /api/brief
//
// Built backwards from the rebuild: the pipeline is one route with modes, so the
// admin is a thin console — run a mode, read that mode's per-step logs, inspect
// the output, copy a trimmed RCA digest. Utilitarian by intent. Expand a zone
// only when a real need appears (persistence export, deep view, cost).

import { useState } from 'react';
import type { Edition } from '@/lib/brief/types';

type StepLog = { name: string; ok: boolean; ms: number; error?: string; logs: string[] };
type ApiResult = {
  mode: string; date: string; edition?: Edition; error?: string;
  steps?: StepLog[]; poolSize?: number; pool?: any[]; briefs?: any[];
};

// Lines worth keeping in an RCA digest — step summaries, failures, funnel counts.
const RCA_KEEP = /\b(fail|error|warn|fallback|short|blocked|notfound|neterr|ratelimit|reachability|assembled|used events|unique events|below floor|ceiling|written|merged)\b|→|->/i;

const S = {
  box: { border: '1px solid #ddd', borderRadius: 6, padding: '8px 10px', margin: '6px 0', background: '#fff' } as const,
  pre: { background: '#0b0b0b', color: '#d6d6d6', padding: 10, borderRadius: 6, overflow: 'auto', fontSize: 12, maxHeight: 340, whiteSpace: 'pre-wrap', margin: '6px 0 0' } as const,
  btn: { padding: '6px 12px', marginRight: 8, marginBottom: 6, cursor: 'pointer', border: '1px solid #bbb', borderRadius: 6, background: '#f7f7f7' } as const,
  chip: { display: 'inline-block', background: '#eef', borderRadius: 10, padding: '1px 8px', margin: 2, fontSize: 12 } as const,
  head: { cursor: 'pointer', fontFamily: 'ui-monospace, monospace', fontSize: 13 } as const,
};

export default function Admin() {
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
      const r = await fetch(`/api/brief?mode=${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, edition, date: date || undefined, selections }),
      });
      const j: ApiResult = await r.json();
      if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
      setRes(j);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }

  const digest = (steps: StepLog[] = []) =>
    steps.flatMap((s) => [
      `— ${s.name} ${s.ok ? 'ok' : 'FAIL'} ${s.ms}ms${s.error ? ' :: ' + s.error : ''}`,
      ...s.logs.filter((l) => RCA_KEEP.test(l)),
    ]).join('\n');
  const copy = (t: string) => { try { navigator.clipboard?.writeText(t); } catch { /* noop */ } };
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div style={{ maxWidth: 900, margin: '20px auto', padding: '0 14px', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 4px' }}>Brief pipeline console</h2>
      <div style={{ color: '#777', fontSize: 13, marginBottom: 10 }}>one route, modes: pool → route → full. each returns per-step logs.</div>

      {/* Controls */}
      <div style={S.box}>
        <label>date&nbsp;
          <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD (today)" style={{ padding: 4 }} />
        </label>
        &nbsp;&nbsp;
        <label>edition&nbsp;
          <select value={edition} onChange={(e) => setEdition(e.target.value as Edition)} style={{ padding: 4 }}>
            <option value="5min">5min</option><option value="10min">10min</option>
          </select>
        </label>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>selections JSON (blank → use profiles)</summary>
          <textarea value={selText} onChange={(e) => setSelText(e.target.value)} rows={5} spellCheck={false}
            placeholder='[{"userId":"u1","cities":["Bengaluru"],"interests":["Markets & Investing","Sport"],"industries":[]}]'
            style={{ width: '100%', marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
        </details>
      </div>

      {/* Run */}
      <div style={{ margin: '10px 0' }}>
        {(['fetch', 'route', 'full'] as const).map((m) => (
          <button key={m} style={S.btn} disabled={!!busy} onClick={() => run(m)}>
            {busy === m ? '…running' : m === 'fetch' ? 'Pool (fetch+dedupe)' : m === 'route' ? 'Route' : 'Full run'}
          </button>
        ))}
      </div>
      {err && <div style={{ ...S.box, color: 'crimson' }}>error: {err}</div>}

      {res && (
        <>
          {/* Steps */}
          <h3 style={{ margin: '14px 0 4px' }}>Steps</h3>
          {(res.steps || []).map((s) => (
            <div key={s.name} style={S.box}>
              <div style={S.head} onClick={() => toggle(s.name)}>
                <span style={{ color: s.ok ? 'green' : 'crimson' }}>{s.ok ? '●' : '✕'}</span>{' '}
                {s.name} · {s.ms}ms{s.error ? ` · ${s.error}` : ''} · {s.logs.length} lines {open[s.name] ? '▾' : '▸'}
              </div>
              {open[s.name] && <pre style={S.pre}>{s.logs.join('\n') || '(no output)'}</pre>}
            </div>
          ))}

          {/* Output */}
          <h3 style={{ margin: '14px 0 4px' }}>Output · {res.mode}</h3>
          {res.mode === 'fetch' && <PoolView pool={res.pool} size={res.poolSize} />}
          {res.mode === 'route' && <RouteView briefs={res.briefs} />}
          {res.mode === 'full' && <FullView briefs={res.briefs} open={open} toggle={toggle} />}

          {/* Export */}
          <h3 style={{ margin: '14px 0 4px' }}>Export</h3>
          <button style={S.btn} onClick={() => copy(digest(res.steps))}>Copy RCA digest</button>
          <button style={S.btn} onClick={() => copy((res.steps || []).flatMap((s) => s.logs).join('\n'))}>Copy full logs</button>
          <button style={S.btn} onClick={() => copy(JSON.stringify(res, null, 2))}>Copy raw JSON</button>
        </>
      )}
    </div>
  );
}

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
          <div>{(b.sections || []).map((s: any) => (
            <span key={s.key} style={{ ...S.chip, background: s.kind === 'core' ? '#efe' : '#eef' }}>{s.key}:{s.count}</span>
          ))}</div>
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
            <div style={S.head} onClick={() => toggle(key)}>
              <b>{b.userId}</b> · {b.edition} · {total} stories · {(b.sections || []).length} sections {open[key] ? '▾' : '▸'}
            </div>
            {open[key] && (b.sections || []).map((sec: any) => (
              <div key={sec.key} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
                <div style={{ fontSize: 13 }}><b>{sec.label}</b> <span style={{ color: '#888' }}>({sec.kind}, {sec.stories?.length || 0})</span></div>
                {sec.why_it_matters && <div style={{ fontSize: 12, fontStyle: 'italic', color: '#556', margin: '2px 0 4px' }}>{sec.why_it_matters}</div>}
                {(sec.stories || []).map((st: any) => (
                  <div key={st.eventId} style={{ fontSize: 12, padding: '2px 0' }}>
                    • {st.headline} {st.hook ? <span style={{ color: '#777' }}>— {st.hook}</span> : ''}
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
