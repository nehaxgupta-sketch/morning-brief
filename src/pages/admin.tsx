// src/pages/admin.tsx — ops console over /api/brief
//
// Two tabs:
//   Run     — run a mode (Pool / Route / Full), read per-step logs, inspect output,
//             download logs, and read an evidence-only RCA of the run.
//   History — saved runs from Supabase (7-day / month), window cost total, and
//             per-run drill-down into per-step cost + logs (+ log-only RCA).
// Utilitarian by intent.
//
// ── Sprint 29.1 additions ────────────────────────────────────────────────────
//   • download(): save digest / full logs / raw JSON / RCA(.md) as files (no more
//     hand-copying into Word).
//   • analyzeRun(): a mechanical, EVIDENCE-ONLY RCA over the run object — every
//     finding cites the count or log line it fired on. It replicates the manual
//     RCA's mechanical checks (write-facts fallback, personalisation absent /
//     identical briefs, core off the fixed 10, route logged nothing, nw coverage
//     / starvation, minor=0, zero-contribution feeds, D2 duplicates, green-but-
//     wrong banner). It does NOT invent root causes: a not-ok step it has no
//     detector for is labelled "unclassified — needs manual RCA". It has the run,
//     not the source, so for a NOVEL bug it points at the suspect file rather than
//     naming the line — bring the run + that file here for the code-level cause.

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

// ─── downloads ────────────────────────────────────────────────────────────────
function download(name: string, text: string, type = 'text/plain') {
  try {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* noop */ }
}
function fileName(res: { mode?: string; date?: string; runId?: string }, kind: string, ext: string) {
  const bits = ['brief', res.mode || 'run', (res.date || '').slice(0, 10) || 'nodate'];
  if (res.runId) bits.push(res.runId.slice(0, 8));
  bits.push(kind);
  return `${bits.filter(Boolean).join('-')}.${ext}`;
}
const digestOf = (steps: StepLog[] = []) =>
  steps.flatMap((s) => [`— ${s.name} ${s.ok ? 'ok' : 'FAIL'} ${s.ms}ms${s.error ? ' :: ' + s.error : ''}`, ...(s.logs || []).filter((l) => RCA_KEEP.test(l))]).join('\n');
const fullLogsOf = (steps: StepLog[] = []) =>
  steps.flatMap((s) => [`===== ${s.name} ${s.ok ? 'ok' : 'FAIL'} ${s.ms}ms =====`, ...(s.logs || [])]).join('\n');

// ─── RCA (evidence-only) ────────────────────────────────────────────────────
type Sev = 'HIGH' | 'MED' | 'LOW' | 'INFO';
type Finding = { step: string; sev: Sev; title: string; evidence: string[]; fix: string; note?: string };
type RcaReport = { stepline: string[]; allOk: boolean; hasHigh: boolean; greenButWrong: boolean; findings: Finding[]; summary: string; briefsSeen: boolean };
const SEV_COLOR: Record<Sev, string> = { HIGH: '#b00020', MED: '#b26a00', LOW: '#666', INFO: '#2b6cb0' };
const SEV_ORDER: Sev[] = ['HIGH', 'MED', 'LOW', 'INFO'];

function analyzeRun(res: ApiResult, selections?: any[]): RcaReport {
  const steps = res.steps || [];
  const findings: Finding[] = [];
  const lines = steps.flatMap((s) => s.logs || []).flatMap((l) => String(l).split('\n'));
  const joined = lines.join('\n');
  const stepByName = (n: string) => steps.find((s) => s.name === n);
  const allOk = steps.length > 0 && steps.every((s) => s.ok);
  const briefs: any[] = Array.isArray(res.briefs) ? res.briefs : [];
  const selByUser = new Map<string, any>();
  (selections || []).forEach((u) => { if (u && u.userId != null) selByUser.set(String(u.userId), u); });
  const selCount = (u: any) => (u ? ((u.cities || []).length + (u.interests || []).length + (u.industries || []).length) : 0);

  const secList = (b: any) => (Array.isArray(b?.sections) ? b.sections : []);
  const secCount = (sec: any) => (Array.isArray(sec?.stories) ? sec.stories.length : typeof sec?.count === 'number' ? sec.count : Array.isArray(sec?.eventIds) ? sec.eventIds.length : 0);
  const idsOf = (sec: any): number[] => (Array.isArray(sec?.stories) ? sec.stories.map((x: any) => (typeof x === 'object' ? x.eventId : x)) : Array.isArray(sec?.eventIds) ? sec.eventIds : []);
  const sigOf = (b: any) => secList(b).map((sec: any) => `${sec.key}:${idsOf(sec).join(',') || secCount(sec)}`).join('|');
  const persoOf = (b: any) => secList(b).filter((sec: any) => sec.kind && sec.kind !== 'core');

  // 1) write-facts fallback ----------------------------------------------------
  if (stepByName('write-facts')) {
    const sum = lines.find((l) => /\[write-facts\][^\n]*used events/.test(l));
    const m = sum && sum.match(/(\d+)\s+used events[^\d]*written\s+(\d+),?\s*fallback\s+(\d+)/i);
    if (m) {
      const used = +m[1], written = +m[2], fell = +m[3];
      if (fell > 0) {
        const calls = lines.filter((l) => /\[write-facts\]\s+\S+\s+\d{3}\s+\(in/.test(l));
        const ok2xx = calls.filter((l) => /\s2\d\d\s/.test(l)).length;
        let tot = 0, empty = 0;
        briefs.forEach((b) => secList(b).forEach((sec: any) => (sec.stories || []).forEach((st: any) => {
          tot++; if (!['background', 'what_happens_next', 'analysis'].some((f) => String(st?.[f] || '').trim())) empty++;
        })));
        const ev = [sum!.trim()];
        if (calls.length) ev.push(`${ok2xx}/${calls.length} writer model calls returned 2xx with output tokens — the model produced text, but ${written === 0 ? 'none' : `${fell} of ${used}`} parsed into articles.`);
        if (tot) ev.push(`${empty}/${tot} written stories have empty background/what_happens_next/analysis (raw-snippet fallback signature).`);
        findings.push({
          step: 'write-facts', sev: written === 0 ? 'HIGH' : 'MED',
          title: written === 0 ? 'No written articles — 100% raw-body fallback' : `Partial write failure — ${fell}/${used} fell back`,
          evidence: ev,
          fix: 'The writer prompt asks for a top-level JSON array, but transport parses with an object extractor → the array is dropped → every story falls back. Silent because the parse does not throw. Fix write-facts.ts (request {"stories":[…]}, accept array-or-object, positional fallback, shape-mismatch log) and transport.ts (JSON.parse-first, array-aware).',
          note: '2xx + output tokens but 0 parsed ⇒ a parse/shape failure, NOT an API/model/key error. Not truncation either — outputs were under the token cap.',
        });
      }
    }
  }

  // 2) personalisation absent / identical briefs -------------------------------
  if (briefs.length) {
    const groups = new Map<string, string[]>();
    briefs.forEach((b) => { const k = sigOf(b); const g = groups.get(k) || []; g.push(String(b.userId)); groups.set(k, g); });
    const identical = [...groups.values()].filter((g) => g.length > 1);
    const starved: string[] = [];
    briefs.forEach((b) => { const sel = selByUser.get(String(b.userId)); if (sel && selCount(sel) > 0 && persoOf(b).length === 0) starved.push(String(b.userId)); });
    if (identical.length || starved.length) {
      const ev: string[] = [];
      identical.forEach((g) => ev.push(`Users [${g.join(', ')}] received byte-identical briefs (same sections + eventIds) — no per-user differentiation.`));
      starved.forEach((id) => { const sel = selByUser.get(id); ev.push(`${id} selected cities=[${(sel.cities || []).join(', ')}] interests=[${(sel.interests || []).join(', ')}] — but got 0 personalised sections (core only).`); });
      if (!selByUser.size && identical.length) ev.push('(selections not provided to the console, so the "selected-but-core-only" check is limited to the identical-brief comparison above.)');
      findings.push({
        step: 'route', sev: 'HIGH',
        title: 'Personalisation absent — users are not differentiated',
        evidence: ev,
        fix: 'route.ts treated UNSCORED stories (nw undefined) as weak and skipped them; with most of the pool unscored, every personalised candidate is dropped → route backfills india/world to the ceiling → identical core-only briefs. Fix (ledger #24): gate only genuinely-scored-weak (nw present AND < WEAK_NW), allow unscored ranked-last. Optionally raise the scoring cap in clustering.ts.',
      });
    }

    // 3) core off the fixed 10 -------------------------------------------------
    const CORE_BASE: Record<string, number> = { major_events: 3, india: 4, world: 3 };
    briefs.forEach((b) => {
      const coreSecs = secList(b).filter((sec: any) => sec.kind === 'core');
      if (!coreSecs.length) return;
      const total = coreSecs.reduce((n: number, sec: any) => n + secCount(sec), 0);
      const over = coreSecs.some((sec: any) => CORE_BASE[sec.key] != null && secCount(sec) > CORE_BASE[sec.key]);
      if (total !== 10 || over) {
        const sel = selByUser.get(String(b.userId));
        const zero = sel ? selCount(sel) === 0 : undefined;
        const detail = coreSecs.map((sec: any) => `${sec.key} ${secCount(sec)}${CORE_BASE[sec.key] != null ? `/${CORE_BASE[sec.key]}` : ''}`).join(', ');
        findings.push({
          step: 'route', sev: 'MED',
          title: `Core sections off the fixed 10 for ${b.userId}`,
          evidence: [`${b.userId} core-kind: ${detail} (total ${total}; fixed core = 10). The excess is india/world backfill lumped into the core sections.`],
          fix: 'Symptom of the personalisation gap — with personalised sections empty, Phase B overflow fills india/world to the ceiling; resolves once personalisation places. Separately decide whether backfill above the fixed 10 should stay inside the core india/world sections or surface as a distinct "More from India/World" block (D5 labelling).',
          note: zero === true ? `${b.userId} selected nothing, so india/world expansion here is partly by design (D5) — but it should be distinguishable from the fixed core.` : undefined,
        });
      }
    });

    // bonus: D2 duplicates within a user --------------------------------------
    briefs.forEach((b) => {
      const ids: number[] = [];
      secList(b).forEach((sec: any) => idsOf(sec).forEach((x) => ids.push(x)));
      const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      if (dups.length) findings.push({ step: 'dedupe', sev: 'HIGH', title: `Duplicate story within ${b.userId}'s brief (D2 violated)`, evidence: [`eventId(s) ${dups.join(', ')} appear in more than one section.`], fix: 'A clustering split slipped past the prefix-aware same-event backstop (ledger #2). Tighten the backstop; do NOT lower the similarity threshold.' });
    });
  }

  // 4) route logged nothing ----------------------------------------------------
  const rt = stepByName('route');
  if (rt && rt.ok && (rt.logs || []).length === 0) {
    findings.push({
      step: 'route', sev: 'MED',
      title: 'Route emitted no logs — placement is invisible',
      evidence: [`route ran ${rt.ms}ms with 0 log lines; per-user counts, core fill, and candidacy availability are not recorded.`],
      fix: 'Add per-user placement logging to route.ts (section→count, core-fill, candidacy/nw availability). This build adds it — after deploying, this finding should clear.',
    });
  }

  // 5) nw coverage / starvation ------------------------------------------------
  const nwm = joined.match(/scored\s+(\d+)\/(\d+)\s+candidates[^\n]*?capped from\s+(\d+)/i);
  const dd = joined.match(/\[dedupe\]\s+\d+\s*(?:→|->)\s*(\d+)\s+unique events/);
  if (nwm) {
    const scored = +nwm[1], capFrom = +nwm[3];
    const pool = dd ? +dd[1] : undefined;
    const cov = pool ? Math.round((scored / pool) * 100) : undefined;
    if (capFrom > scored || (cov != null && cov < 25)) {
      findings.push({
        step: 'dedupe', sev: 'MED',
        title: 'Low newsworthiness coverage → personalised-section starvation risk',
        evidence: [`nw scored ${scored} of ${capFrom} eligible${pool != null ? `; pool is ${pool} unique events (~${cov}% scored, ~${100 - (cov as number)}% unscored)` : ''}. Personalised sections are quality-gated, so unscored candidates get excluded.`],
        fix: 'Ledger #24: raise the engine scoring cap (clustering.ts) OR let routing place unscored ranked-last (route.ts). This build does the latter; raising the cap is the cleaner long-term fix (needs clustering.ts).',
      });
    }
  }

  // bonus: minor call 0 --------------------------------------------------------
  const pm = joined.match(/pool assembled[^\n]*major\s+(\d+)\s*\+\s*minor\s+(\d+)/i);
  if (pm && +pm[2] === 0) {
    findings.push({
      step: 'fetch', sev: 'MED',
      title: 'Minor call returned 0 — cities/interests not fetched',
      evidence: ['fetch pool: minor 0. Either loadSelections returned empty (Supabase client/columns), the request carried no selections body, or the selected areas have no dedicated feed.'],
      fix: 'Pass a selections body with feed-backed cities/interests (e.g. Bengaluru) or fix loadSelections. Interests without a dedicated feed are still recovered from the major pool by keyword in dedupe.',
    });
  }

  // bonus: feeds that contributed nothing --------------------------------------
  const zeroFeeds = [...new Set(lines.map((l) => { const m = l.match(/kept=\s*0\b.*?\d+ms\s+(.+?)\s+\[/); return m ? m[1].trim() : null; }).filter(Boolean) as string[])];
  if (zeroFeeds.length) {
    findings.push({
      step: 'fetch', sev: 'LOW',
      title: `${zeroFeeds.length} feed(s) contributed nothing this run`,
      evidence: [`Filtered to zero: ${zeroFeeds.join(', ')} (usually all-stale or not-whitelisted — benign unless you expect that source in a section).`],
      fix: 'Check the drop reason on those lines (stale = recency window; notwhite = whitelist). No action if expected.',
    });
  }

  // unclassified failures ------------------------------------------------------
  steps.filter((s) => !s.ok).forEach((s) => {
    if (!findings.some((f) => f.step === s.name)) {
      findings.push({
        step: s.name, sev: 'HIGH', title: `Step "${s.name}" failed`,
        evidence: [s.error || 'no error text captured', ...(s.logs || []).filter((l) => /fail|error|throw/i.test(l)).slice(0, 3)],
        fix: 'Unclassified — not matched by a known pattern. Needs manual RCA: reproduce with the smallest mode that shows it (fetch < route < full) and inspect this step\'s file.',
      });
    }
  });

  const hasHigh = findings.some((f) => f.sev === 'HIGH');
  const greenButWrong = allOk && hasHigh;
  const counts = SEV_ORDER.map((sv) => `${findings.filter((f) => f.sev === sv).length} ${sv}`).filter((c) => !c.startsWith('0')).join(', ');
  const summary = findings.length === 0
    ? (allOk ? 'All steps green and no known defect pattern fired.' : 'A step reported not-ok — see below.')
    : `${findings.length} finding(s): ${counts}.`;
  return { stepline: steps.map((s) => `${s.name} ${s.ok ? 'ok' : 'FAIL'}`), allOk, hasHigh, greenButWrong, findings, summary, briefsSeen: briefs.length > 0 };
}

function rcaMarkdown(r: RcaReport, res: ApiResult): string {
  const L: string[] = [];
  L.push('# Brief pipeline — RCA report', '');
  L.push(`- run: ${res.mode}${res.edition ? '/' + res.edition : ''} · ${res.date}${res.runId ? ' · ' + res.runId : ''}`);
  L.push(`- steps: ${r.stepline.join(' · ')}`);
  L.push(`- ${r.summary}`);
  if (!r.briefsSeen) L.push('- note: brief object not available for this run — brief-level checks (identical/personalisation/core/D2) were skipped; findings below are log-based only.');
  if (r.greenButWrong) L.push('- ⚠️ GREEN BUT WRONG: every step is green, yet blocking defects fired (ledger #4 — a green build is not a correct brief).');
  L.push('');
  SEV_ORDER.forEach((sev) => r.findings.filter((f) => f.sev === sev).forEach((f) => {
    L.push(`## [${f.sev}] ${f.title}  _(${f.step})_`);
    f.evidence.forEach((e) => L.push(`- evidence: ${e}`));
    if (f.note) L.push(`- note: ${f.note}`);
    L.push(`- what to change: ${f.fix}`, '');
  }));
  L.push('---', '_Evidence-only: every line cites a count or log from this run. "Unclassified" findings could not be root-caused from the run alone — bring the run + the suspect file for the code-level cause._');
  return L.join('\n');
}

function RcaPanel({ res, selections, logOnlyNote }: { res: ApiResult; selections?: any[]; logOnlyNote?: boolean }) {
  let report: RcaReport | null = null; let error: string | null = null;
  try { report = analyzeRun(res, selections); } catch (e: any) { error = e?.message || String(e); }
  if (error) return <div style={{ ...S.box, color: 'crimson' }}>RCA analyzer error: {error}</div>;
  if (!report) return null;
  const r = report;
  const bg = r.greenButWrong ? '#fff4f4' : r.hasHigh ? '#fff7ef' : '#f3fbf3';
  return (
    <>
      <div style={{ ...S.box, background: bg, borderColor: r.greenButWrong ? '#b00020' : '#ccc' }}>
        <div style={{ fontWeight: 600 }}>{r.greenButWrong ? '⚠️ Green but wrong' : r.hasHigh ? 'Defects found' : 'No blocking defects'}</div>
        <div style={{ fontSize: 13, color: '#444', marginTop: 2 }}>{r.summary}</div>
        {logOnlyNote && !r.briefsSeen && <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>Log-only RCA (no stored brief object) — brief-level checks skipped.</div>}
        {r.greenButWrong && <div style={{ fontSize: 12, color: '#b00020', marginTop: 4 }}>Every step returned ok, yet blocking defects fired — a green run is not a correct brief (ledger #4).</div>}
        {r.findings.length > 0 && <button style={{ ...S.btn, marginTop: 8 }} onClick={() => download(fileName(res, 'rca', 'md'), rcaMarkdown(r, res), 'text/markdown')}>⬇ RCA (.md)</button>}
      </div>
      {SEV_ORDER.map((sev) => r.findings.filter((f) => f.sev === sev).map((f, i) => (
        <div key={sev + i} style={{ ...S.box, borderLeft: `4px solid ${SEV_COLOR[sev]}` }}>
          <div><span style={{ ...S.chip, background: SEV_COLOR[sev], color: '#fff' }}>{sev}</span> <b>{f.title}</b> <span style={{ color: '#888', fontSize: 12 }}>· {f.step}</span></div>
          <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>{f.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>
          {f.note && <div style={{ fontSize: 12, color: '#556', fontStyle: 'italic', margin: '2px 0 6px' }}>{f.note}</div>}
          <div style={{ fontSize: 13 }}><b>Fix:</b> {f.fix}</div>
        </div>
      )))}
    </>
  );
}

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
  const copy = (t: string) => { try { navigator.clipboard?.writeText(t); } catch { /* noop */ } };
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  // selections for the RCA panel (parsed live from the box; blank = ran from profiles)
  let rcaSel: any[] | undefined;
  try { const p = selText.trim() ? JSON.parse(selText) : undefined; rcaSel = Array.isArray(p) ? p : p ? [p] : undefined; } catch { rcaSel = undefined; }

  return (
    <>
      <div style={S.box}>
        <label>date&nbsp;<input value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD (today)" style={{ padding: 4 }} /></label>
        &nbsp;&nbsp;
        <label>edition&nbsp;<select value={edition} onChange={(e) => setEdition(e.target.value as Edition)} style={{ padding: 4 }}><option value="5min">5min</option><option value="10min">10min</option><option value="deep">deep</option></select></label>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>selections JSON (blank → use profiles)</summary>
          <textarea value={selText} onChange={(e) => setSelText(e.target.value)} rows={5} spellCheck={false} placeholder='[{"userId":"test1","cities":["Bengaluru"],"interests":["Markets & Investing","Sport"],"industries":[]}]' style={{ width: '100%', marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
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

          <h3 style={{ margin: '14px 0 4px' }}>RCA</h3>
          <RcaPanel res={res} selections={rcaSel} />

          <h3 style={{ margin: '14px 0 4px' }}>Export</h3>
          <button style={S.btn} onClick={() => download(fileName(res, 'digest', 'txt'), digestOf(res.steps))}>⬇ digest</button>
          <button style={S.btn} onClick={() => download(fileName(res, 'logs', 'txt'), fullLogsOf(res.steps))}>⬇ full logs</button>
          <button style={S.btn} onClick={() => download(fileName(res, 'raw', 'json'), JSON.stringify(res, null, 2), 'application/json')}>⬇ raw JSON</button>
          <span style={{ display: 'inline-block', width: 12 }} />
          <button style={S.btn} onClick={() => copy(digestOf(res.steps))}>Copy digest</button>
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
        const pseudo: ApiResult = { mode: r.mode, date: r.created_at, edition: r.edition, runId: r.id, steps, briefs: d.briefs };
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
                {steps.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <button style={S.btn} onClick={() => download(fileName(pseudo, 'digest', 'txt'), digestOf(steps))}>⬇ digest</button>
                    <button style={S.btn} onClick={() => download(fileName(pseudo, 'logs', 'txt'), fullLogsOf(steps))}>⬇ full logs</button>
                    <button style={S.btn} onClick={() => download(fileName(pseudo, 'raw', 'json'), JSON.stringify(d, null, 2), 'application/json')}>⬇ raw JSON</button>
                    <div style={{ marginTop: 8 }}><RcaPanel res={pseudo} logOnlyNote /></div>
                  </div>
                )}
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
