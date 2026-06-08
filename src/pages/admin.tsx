import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Admin page ──────────────────────────────────────────────────────────────
// Sprint 8 — shows today's status across all 3 editions (The Brief / The Daily /
// The Editorial), with story/section counts adapted to each edition's shape.

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  surfaceDeep: '#0A0A0A',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
  ok: '#5FB87E', warn: '#E0A85C', err: '#E76161',
}

type BriefRow = {
  date: string
  edition: string
  status: string
  generated_at: string | null
  content: any
  raw_stories: any
}

type HistoryDay = {
  date: string
  editions: Record<string, string>
}

function getISTDate(offsetDays = 0): string {
  const now = new Date()
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000
  return new Date(istMs).toISOString().split('T')[0]
}

function formatDayShort(dateISO: string): string {
  const d = new Date(dateISO + 'T00:00:00')
  const day = d.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase()
  return `${day} ${d.getDate()}`
}

function statusColor(status: string) {
  if (status === 'ready') return C.ok
  if (status === 'fallback') return C.warn
  if (status === 'failed') return C.err
  return C.textMute
}

function editionLabel(e: string): string {
  if (e === '5min') return 'The Brief (5min)'
  if (e === '10min') return 'The Daily (10min)'
  if (e === 'deep') return 'The Editorial (deep)'
  return e
}

// ─── Safe fetch+JSON helper ──────────────────────────────────────────────
// On Vercel 300s timeouts the server returns an HTML error page, not JSON.
// `await res.json()` then throws "JSON.parse: unexpected character at line 1"
// with no useful info. This helper reads body as text first, checks status
// and content-type, and either parses JSON or throws a meaningful error
// that includes a snippet of the response so the operator can see what
// actually came back.
async function safeJsonFetch(url: string, init?: RequestInit): Promise<any> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e: any) {
    throw new Error(`Network error reaching ${url}: ${e.message}`)
  }
  const text = await res.text()
  const contentType = res.headers.get('content-type') || ''
  if (!res.ok) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim()
    if (res.status === 504 || /timeout|gateway/i.test(text)) {
      throw new Error(
        `API timed out (HTTP ${res.status}). The function ran past Vercel's 300s limit. ` +
        `Check Vercel logs. Snippet: ${snippet}`
      )
    }
    throw new Error(`API HTTP ${res.status} from ${url}. Snippet: ${snippet}`)
  }
  if (!contentType.includes('application/json')) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim()
    throw new Error(
      `API returned non-JSON (content-type: ${contentType || 'none'}). ` +
      `Snippet: ${snippet}`
    )
  }
  try {
    return JSON.parse(text)
  } catch (e: any) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim()
    throw new Error(`Failed to parse JSON response: ${e.message}. Snippet: ${snippet}`)
  }
}

// Edition-aware story count.
function countStoriesForEdition(content: any, edition: string): number {
  if (!content) return 0
  if (edition === '5min') {
    return ['major_events', 'world', 'india', 'topics']
      .reduce((n, k) => n + (Array.isArray(content[k]) ? content[k].length : 0), 0)
  }
  if (edition === '10min') {
    let n = 0
    for (const k of ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'bengaluru', 'delhi']) {
      if (Array.isArray(content[k])) n += content[k].length
    }
    if (content.sport?.headline) n++
    if (content.culture?.headline) n++
    return n
  }
  if (edition === 'deep') {
    // Editorial: count by pieces, not stories.
    let n = 0
    if (Array.isArray(content.three_patterns)) n += content.three_patterns.length
    if (content.long_read?.body) n += 1
    if (Array.isArray(content.watching_this_week)) n += content.watching_this_week.length
    if (content.signature?.one_number) n += 1
    if (content.signature?.one_chart) n += 1
    if (content.signature?.one_quote) n += 1
    return n
  }
  return 0
}

function countMajorEvents(content: any): number {
  return Array.isArray(content?.major_events) ? content.major_events.length : 0
}

function countPersonalSections(content: any): number {
  return Array.isArray(content?.personal_sections) ? content.personal_sections.length : 0
}

function hasLens(lens: any): boolean {
  return !!(lens && (lens.world || lens.india || lens.markets || lens.watch))
}

// ─── Sprint 11 types + helpers ──────────────────────────────────────────────

type CostRow = {
  id: number
  date: string
  phase: string
  model: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  usd_cost: number
  detail: string | null
  created_at: string
}

type ScoreRow = {
  id: number
  date: string
  edition: string
  dim_coverage: number | null
  dim_field_completeness: number | null
  dim_india_anchor: number | null
  dim_source_quality: number | null
  dim_editorial_sharpness: number | null
  dim_currentness: number | null
  dim_relevance: number | null
  total: number | null
  max_score: number
  notes: string | null
}

function formatUSD(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function formatINR(usd: number): string {
  const inr = usd * 83
  if (inr < 1) return `₹${inr.toFixed(2)}`
  return `₹${inr.toFixed(0)}`
}

function scoreColor(n: number | null): string {
  if (n === null || n === undefined) return C.textDim
  if (n >= 8) return C.ok
  if (n >= 6) return C.gold
  if (n >= 4) return C.warn
  return C.err
}

function totalColor(total: number | null): string {
  if (!total) return C.textDim
  if (total >= 60) return C.ok
  if (total >= 50) return C.gold
  if (total >= 40) return C.warn
  return C.err
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [email, setEmail] = useState<string>('')
  const [rows, setRows] = useState<BriefRow[]>([])
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [regenResult, setRegenResult] = useState<string>('')
  const [selectedDate, setSelectedDate] = useState(getISTDate())
  const [expanded, setExpanded] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryDay[]>([])
  const [personalisedToday, setPersonalisedToday] = useState<{ users: number; ready: number; withCity: number }>({ users: 0, ready: 0, withCity: 0 })
  const [runningPersonalisation, setRunningPersonalisation] = useState(false)
  const [personaliseResult, setPersonaliseResult] = useState<string>('')

  // ─── Sprint 11: cost / score / tail state ───────────────────────────────
  const [costsToday, setCostsToday] = useState<CostRow[]>([])
  const [costs7d, setCosts7d] = useState<CostRow[]>([])
  const [scoresToday, setScoresToday] = useState<ScoreRow[]>([])
  const [scores7d, setScores7d] = useState<ScoreRow[]>([])
  const [tailCounts, setTailCounts] = useState<Record<string, number>>({})
  const [scoring, setScoring] = useState(false)
  const [scoreResult, setScoreResult] = useState<string>('')

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const allowed = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      const userEmail = (user.email || '').toLowerCase()
      setEmail(userEmail)
      if (allowed.length === 0 || allowed.includes(userEmail)) setAuthorized(true)
      else setAuthorized(false)
    }
    checkAuth()
  }, [])

  useEffect(() => {
    if (authorized) {
      loadBriefs()
      loadHistory()
      loadPersonalisedStats()
      loadCostAndScoreData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, selectedDate])

  async function loadBriefs() {
    setLoading(true)
    const { data, error } = await supabase
      .from('briefs')
      .select('date, edition, status, generated_at, content, raw_stories')
      .eq('date', selectedDate)
      .order('edition', { ascending: true })
    if (!error && data) setRows(data as BriefRow[])
    setLoading(false)
  }

  async function regenerate(edition?: string) {
    setRegenerating(true)
    setRegenResult('')
    try {
      if (edition) {
        // Per-edition regenerate: just re-run the writer for that one edition.
        // Assumes today's raw_stories were already fetched (by cron or by the
        // "Regenerate All" button). If not, the API will tell us.
        setRegenResult(`Writing ${edition}…`)
        const data = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'write', edition }),
        })
        const reason = data.reason || data.error || ''
        if (reason && /no raw_stories/i.test(reason)) {
          setRegenResult(
            JSON.stringify(data, null, 2) +
            '\n\nTip: hit "REGENERATE ALL 3 EDITIONS" first — it fetches today\'s news, then this button can re-write a single edition from it.'
          )
        } else {
          setRegenResult(JSON.stringify(data, null, 2))
        }
        await loadBriefs()
      } else {
        // Regenerate all 3 editions. The work is split across multiple Vercel
        // invocations to stay under the 60s function timeout:
        //   1. mode=fetch  — fetch news + lens (~35-45s)
        //   2. mode=write  — three parallel writes (~15-30s each)
        // Each call is its own function invocation with its own 60s budget.

        // Stage 1 — fetch
        setRegenResult('Stage 1/2 — fetching today\'s news (~40s)…')
        const fetchData = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'fetch' }),
        })
        if (!fetchData.ok) {
          setRegenResult('FETCH FAILED:\n' + JSON.stringify(fetchData, null, 2))
          await loadBriefs()
          setRegenerating(false)
          return
        }
        await loadBriefs() // shows pending rows

        // Stage 2 — writes (parallel)
        setRegenResult(
          'Stage 1/2 — fetch ✓\n' +
          'sections: ' + JSON.stringify(fetchData.sections) + '\n\n' +
          'Stage 2/2 — writing 5min, 10min, deep in parallel (~25s)…'
        )
        const writeResults = await Promise.all(
          (['5min', '10min', 'deep'] as const).map(async (ed) => {
            try {
              return await safeJsonFetch('/api/generate-brief', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'write', edition: ed }),
              })
            } catch (err: any) {
              return { edition: ed, ok: false, error: err.message }
            }
          })
        )

        setRegenResult(JSON.stringify({
          fetch: { ok: fetchData.ok, sections: fetchData.sections, lens_ok: fetchData.lens_ok },
          writes: writeResults,
        }, null, 2))
        await loadBriefs()
        await loadCostAndScoreData()
      }
    } catch (e: any) {
      setRegenResult('Error: ' + e.message)
    }
    setRegenerating(false)
  }

  async function loadHistory() {
    const today = getISTDate()
    const sixDaysAgo = getISTDate(-6)
    const { data } = await supabase
      .from('briefs')
      .select('date, edition, status')
      .gte('date', sixDaysAgo)
      .lte('date', today)
    if (!data) { setHistory([]); return }

    const byDate: Record<string, Record<string, string>> = {}
    for (const r of data as any[]) {
      if (!byDate[r.date]) byDate[r.date] = {}
      byDate[r.date][r.edition] = r.status
    }
    const days: HistoryDay[] = []
    for (let i = 0; i < 7; i++) {
      const d = getISTDate(-i)
      days.push({ date: d, editions: byDate[d] || {} })
    }
    setHistory(days)
  }

  async function loadPersonalisedStats() {
    const [u, r, withCity] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('brief_type', 'personalised'),
      supabase.from('personalised_briefs').select('id', { count: 'exact', head: true }).eq('date', selectedDate).eq('status', 'ready'),
      supabase.from('personalised_briefs')
        .select('id, content', { count: 'exact', head: false })
        .eq('date', selectedDate)
        .eq('status', 'ready'),
    ])
    const cityCount = (withCity.data ?? []).filter((row: any) =>
      Array.isArray(row?.content?.personal_sections) &&
      row.content.personal_sections.some((s: any) => s?.id === 'your_city')
    ).length
    setPersonalisedToday({ users: u.count || 0, ready: r.count || 0, withCity: cityCount })
  }

  async function runPersonalisation() {
    setRunningPersonalisation(true)
    setPersonaliseResult('')
    try {
      const data = await safeJsonFetch('/api/personalise-briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setPersonaliseResult(JSON.stringify(data, null, 2))
      await loadPersonalisedStats()
      await loadCostAndScoreData()
    } catch (e: any) {
      setPersonaliseResult('Error: ' + e.message)
    }
    setRunningPersonalisation(false)
  }

  // ─── Sprint 11 loaders ─────────────────────────────────────────────────
  async function loadCostAndScoreData() {
    const sevenDaysAgo = getISTDate(-7)

    const [todayCosts, weekCosts, todayScores, weekScores, personalisedRows] = await Promise.all([
      supabase.from('brief_costs').select('*').eq('date', selectedDate).order('created_at', { ascending: true }),
      supabase.from('brief_costs').select('*').gte('date', sevenDaysAgo).order('date', { ascending: true }),
      supabase.from('brief_scores').select('*').eq('date', selectedDate).order('edition'),
      supabase.from('brief_scores').select('*').gte('date', sevenDaysAgo).order('date', { ascending: true }),
      supabase.from('personalised_briefs').select('content').eq('date', selectedDate).eq('edition', '10min'),
    ])

    setCostsToday((todayCosts.data || []) as CostRow[])
    setCosts7d((weekCosts.data || []) as CostRow[])
    setScoresToday((todayScores.data || []) as ScoreRow[])
    setScores7d((weekScores.data || []) as ScoreRow[])

    const counts: Record<string, number> = {}
    for (const row of personalisedRows.data || []) {
      const status = (row as any).content?.tail_status || 'unknown'
      counts[status] = (counts[status] || 0) + 1
    }
    setTailCounts(counts)
  }

  async function triggerScoring() {
    setScoring(true)
    setScoreResult('Scoring…')
    try {
      const data = await safeJsonFetch('/api/generate-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'score' }),
      })
      if (data.ok) {
        setScoreResult('Scoring complete.')
        await loadCostAndScoreData()
      } else {
        setScoreResult('Failed: ' + (data.error || JSON.stringify(data)))
      }
    } catch (e: any) {
      setScoreResult('Error: ' + e.message)
    }
    setScoring(false)
  }

  if (authorized === null) return <CenteredMsg>Checking access…</CenteredMsg>

  if (authorized === false) {
    return (
      <CenteredMsg>
        <div style={{
          fontFamily: "'Playfair Display', serif", fontSize: '26px',
          color: C.text, marginBottom: '14px', lineHeight: 1.3,
        }}>Not authorised</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '16px', color: C.textSoft,
        }}>{email} doesn't have admin access.</div>
      </CenteredMsg>
    )
  }

  return (
    <>
      <Head><title>Admin — Morning Brief</title></Head>
      <div style={{ minHeight: '100vh', background: C.bg, padding: '32px 20px 80px', maxWidth: '920px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: '36px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
          <div>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold, marginBottom: '8px',
            }}>MORNING BRIEF · ADMIN</div>
            <h1 style={{
              fontFamily: "'Playfair Display', serif", fontSize: '32px',
              fontWeight: 900, color: C.text, margin: 0, lineHeight: 1.15,
            }}>Brief Status</h1>
          </div>
          <Link href="/brief" style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px', color: C.textSoft,
            textDecoration: 'none', border: `1px solid ${C.border}`, padding: '10px 16px',
            letterSpacing: '1.5px', whiteSpace: 'nowrap', minHeight: '44px',
            display: 'flex', alignItems: 'center',
          }}>← BACK TO APP</Link>
        </div>

        {/* 7-day history */}
        {history.length > 0 && (
          <div style={{ marginBottom: '32px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2px', color: C.textMute, marginBottom: '14px',
            }}>LAST 7 DAYS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
              {history.map((day) => {
                const isSelected = day.date === selectedDate
                return (
                  <button key={day.date} onClick={() => setSelectedDate(day.date)} style={{
                    border: `1px solid ${isSelected ? C.gold : C.border}`,
                    background: isSelected ? C.surface2 : C.surfaceDeep,
                    padding: '12px 4px', cursor: 'pointer',
                    textAlign: 'center', minHeight: '60px',
                  }} title={day.date}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      color: isSelected ? C.gold : C.textSoft,
                      marginBottom: '10px', letterSpacing: '0.5px',
                    }}>{formatDayShort(day.date)}</div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '5px' }}>
                      {(['5min', '10min', 'deep'] as const).map((ed) => {
                        const status = day.editions[ed]
                        return (
                          <span key={ed} title={`${ed}: ${status || 'missing'}`} style={{
                            width: '9px', height: '9px', borderRadius: '50%',
                            background: status ? statusColor(status) : 'transparent',
                            border: status ? 'none' : `1px solid ${C.borderHi}`,
                            display: 'inline-block',
                          }} />
                        )
                      })}
                    </div>
                  </button>
                )
              })}
            </div>
            <div style={{
              display: 'flex', gap: '18px', marginTop: '14px',
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              color: C.textMute, letterSpacing: '1.5px', flexWrap: 'wrap',
            }}>
              <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: statusColor('ready'), marginRight: '6px' }} />READY</span>
              <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: statusColor('fallback'), marginRight: '6px' }} />FALLBACK</span>
              <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: statusColor('failed'), marginRight: '6px' }} />FAILED</span>
              <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', border: `1px solid ${C.borderHi}`, marginRight: '6px' }} />MISSING</span>
            </div>
          </div>
        )}

        {/* Date picker */}
        <div style={{ marginBottom: '28px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            color: C.textMute, letterSpacing: '1.5px',
          }}>DATE:</span>
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} style={{
            background: C.surface2, border: `1px solid ${C.border}`, color: C.text,
            padding: '10px 14px', fontFamily: "'DM Mono', monospace", fontSize: '13px',
            minHeight: '44px',
          }} />
          <button onClick={() => setSelectedDate(getISTDate())} style={{
            background: 'none', border: `1px solid ${C.border}`, color: C.textSoft,
            padding: '10px 14px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.5px', cursor: 'pointer', minHeight: '44px',
          }}>TODAY</button>
        </div>

        {/* Editions grid */}
        {loading ? (
          <div style={{
            color: C.textMute, fontFamily: "'DM Mono', monospace",
            padding: '24px', fontSize: '13px',
          }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{
            border: `1px solid ${C.border}`, padding: '24px', color: C.textSoft,
            fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
            marginBottom: '24px', background: C.surface, lineHeight: 1.6,
          }}>
            No briefs found for {selectedDate}. The cron may not have run yet, or the date might be in the future.
          </div>
        ) : (
          rows.map((row) => {
            const majorCount = countMajorEvents(row.content)
            const storyCount = countStoriesForEdition(row.content, row.edition)
            return (
              <div key={row.edition} style={{
                border: `1px solid ${C.border}`,
                borderLeft: `3px solid ${statusColor(row.status)}`,
                padding: '22px', marginBottom: '16px', background: C.surface2,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <div style={{
                    fontFamily: "'Playfair Display', serif", fontSize: '22px',
                    fontWeight: 700, color: C.text,
                  }}>{editionLabel(row.edition)}</div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '11px', letterSpacing: '2px',
                    color: statusColor(row.status), textTransform: 'uppercase',
                  }}>{row.status}</div>
                </div>

                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px',
                  fontFamily: "'DM Mono', monospace", fontSize: '12px',
                  color: C.textMute, marginBottom: '16px',
                }}>
                  <div>stories / blocks: <span style={{ color: C.text }}>{storyCount}</span></div>
                  <div>major events: <span style={{ color: C.text }}>{majorCount}</span></div>
                  <div>closer: <span style={{ color: C.text }}>{row.content?.closer ? 'yes' : 'no'}</span></div>
                  <div>lens: <span style={{ color: hasLens(row.content?.lens) ? C.ok : C.warn }}>{hasLens(row.content?.lens) ? 'yes' : 'no'}</span></div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    generated: <span style={{ color: C.text }}>{row.generated_at ? new Date(row.generated_at).toLocaleString('en-IN') : '—'}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button onClick={() => setExpanded(expanded === row.edition ? null : row.edition)} style={{
                    background: 'none', border: `1px solid ${C.border}`, color: C.textSoft,
                    padding: '8px 14px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    letterSpacing: '1.5px', cursor: 'pointer', minHeight: '40px',
                  }}>{expanded === row.edition ? 'HIDE JSON' : 'VIEW JSON'}</button>
                  <button onClick={() => regenerate(row.edition)} disabled={regenerating} style={{
                    background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
                    padding: '8px 14px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    letterSpacing: '1.5px',
                    cursor: regenerating ? 'not-allowed' : 'pointer',
                    opacity: regenerating ? 0.5 : 1, minHeight: '40px',
                  }}>REGENERATE</button>
                </div>

                {expanded === row.edition && (
                  <pre style={{
                    marginTop: '16px', padding: '16px', background: C.surfaceDeep,
                    border: `1px solid ${C.border}`, color: C.textSoft,
                    fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    maxHeight: '420px', overflow: 'auto', whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                  }}>{JSON.stringify(row.content, null, 2)}</pre>
                )}
              </div>
            )
          })
        )}

        {/* Regenerate all */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <button onClick={() => regenerate(undefined)} disabled={regenerating} style={{
            background: C.gold, color: '#0E0E0E', border: 'none',
            padding: '16px 28px', fontFamily: "'DM Mono', monospace", fontSize: '12px',
            letterSpacing: '2px', fontWeight: 700,
            cursor: regenerating ? 'not-allowed' : 'pointer',
            opacity: regenerating ? 0.6 : 1, minHeight: '52px',
          }}>{regenerating ? 'GENERATING… (~65s)' : 'REGENERATE ALL 3 EDITIONS'}</button>

          {regenResult && (
            <pre style={{
              marginTop: '18px', padding: '16px', background: C.surfaceDeep,
              border: `1px solid ${C.border}`, color: C.textSoft,
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}>{regenResult}</pre>
          )}
        </div>

        {/* Personalisation panel */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
          }}>PERSONALISATION</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div style={{
              border: `1px solid ${C.border}`, padding: '16px', background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px', color: C.textMute,
            }}>
              <div style={{ marginBottom: '6px', letterSpacing: '1px' }}>USERS</div>
              <div style={{ color: C.text, fontSize: '20px', fontWeight: 700 }}>{personalisedToday.users}</div>
            </div>
            <div style={{
              border: `1px solid ${C.border}`, padding: '16px', background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px', color: C.textMute,
            }}>
              <div style={{ marginBottom: '6px', letterSpacing: '1px' }}>READY</div>
              <div style={{ color: C.text, fontSize: '20px', fontWeight: 700 }}>{personalisedToday.ready}</div>
            </div>
            <div style={{
              border: `1px solid ${C.border}`, padding: '16px', background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px', color: C.textMute,
            }}>
              <div style={{ marginBottom: '6px', letterSpacing: '1px' }}>W/ CITY</div>
              <div style={{ color: C.text, fontSize: '20px', fontWeight: 700 }}>{personalisedToday.withCity}</div>
            </div>
          </div>
          <button onClick={runPersonalisation} disabled={runningPersonalisation} style={{
            background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
            padding: '14px 20px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2px',
            cursor: runningPersonalisation ? 'not-allowed' : 'pointer',
            opacity: runningPersonalisation ? 0.5 : 1, minHeight: '48px',
          }}>{runningPersonalisation ? 'RUNNING…' : 'RUN PERSONALISATION NOW'}</button>

          {personaliseResult && (
            <pre style={{
              marginTop: '16px', padding: '16px', background: C.surfaceDeep,
              border: `1px solid ${C.border}`, color: C.textSoft,
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}>{personaliseResult}</pre>
          )}
        </div>

        {/* ─── Sprint 11: Cost panel ──────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
          }}>COST · {selectedDate}</div>

          {(() => {
            const total = costsToday.reduce((s, r) => s + Number(r.usd_cost), 0)
            return (
              <>
                <div style={{
                  fontFamily: "'Playfair Display', serif",
                  fontSize: '34px', fontWeight: 700, color: C.gold,
                  lineHeight: 1.1, marginBottom: '4px',
                }}>{formatUSD(total)}</div>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '12px',
                  color: C.textMute, marginBottom: '20px',
                }}>
                  ≈ {formatINR(total)} · {costsToday.length} API call{costsToday.length === 1 ? '' : 's'}
                </div>
              </>
            )
          })()}

          {/* Per-phase breakdown */}
          {costsToday.length > 0 && (() => {
            const byPhase = new Map<string, { phase: string; calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; usd: number }>()
            for (const r of costsToday) {
              const cur = byPhase.get(r.phase) || { phase: r.phase, calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0 }
              cur.calls += 1
              cur.inputTokens += r.input_tokens
              cur.outputTokens += r.output_tokens
              cur.reasoningTokens += r.reasoning_tokens || 0
              cur.usd += Number(r.usd_cost)
              byPhase.set(r.phase, cur)
            }
            const phases = Array.from(byPhase.values()).sort((a, b) => b.usd - a.usd)
            return (
              <div style={{ border: `1px solid ${C.border}`, background: C.surface2 }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1.2fr 0.6fr 1fr 1fr 0.8fr',
                  gap: '12px', padding: '12px 16px', borderBottom: `1px solid ${C.border}`,
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '1.5px', color: C.textMute,
                }}>
                  <div>PHASE</div>
                  <div style={{ textAlign: 'right' }}>CALLS</div>
                  <div style={{ textAlign: 'right' }}>IN TOKENS</div>
                  <div style={{ textAlign: 'right' }}>OUT TOKENS</div>
                  <div style={{ textAlign: 'right' }}>USD</div>
                </div>
                {phases.map(p => (
                  <div key={p.phase} style={{
                    display: 'grid', gridTemplateColumns: '1.2fr 0.6fr 1fr 1fr 0.8fr',
                    gap: '12px', padding: '12px 16px',
                    borderBottom: `1px solid ${C.border}`,
                    fontFamily: "'DM Mono', monospace", fontSize: '12px',
                    color: C.textSoft,
                  }}>
                    <div style={{ color: C.gold, letterSpacing: '1px' }}>{p.phase.toUpperCase()}</div>
                    <div style={{ textAlign: 'right' }}>{p.calls}</div>
                    <div style={{ textAlign: 'right' }}>{p.inputTokens.toLocaleString()}</div>
                    <div style={{ textAlign: 'right' }}>{(p.outputTokens + p.reasoningTokens).toLocaleString()}</div>
                    <div style={{ textAlign: 'right', color: C.text, fontWeight: 700 }}>{formatUSD(p.usd)}</div>
                  </div>
                ))}
              </div>
            )
          })()}

          {costsToday.length === 0 && (
            <div style={{
              border: `1px solid ${C.border}`, padding: '20px', color: C.textMute,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
              background: C.surface2, fontStyle: 'italic',
            }}>
              No API calls logged for {selectedDate}. The fetch cron runs at 6:30 IST. Cost data tracked from Sprint 11 onwards.
            </div>
          )}

          {/* 7-day cost trend */}
          {(() => {
            const byDay = new Map<string, number>()
            for (const r of costs7d) byDay.set(r.date, (byDay.get(r.date) || 0) + Number(r.usd_cost))
            const days: { date: string; usd: number }[] = []
            for (let i = -7; i <= 0; i++) {
              const d = getISTDate(i)
              days.push({ date: d, usd: byDay.get(d) || 0 })
            }
            const maxDay = Math.max(0.01, ...days.map(d => d.usd))
            const weekTotal = days.reduce((s, d) => s + d.usd, 0)
            return (
              <div style={{ marginTop: '20px' }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '2px', color: C.textMute, marginBottom: '12px',
                }}>8-DAY TREND · TOTAL {formatUSD(weekTotal)}</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '70px' }}>
                  {days.map(d => {
                    const heightPct = (d.usd / maxDay) * 100
                    const isSelected = d.date === selectedDate
                    return (
                      <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                        <div style={{
                          width: '100%',
                          height: `${Math.max(2, heightPct)}%`,
                          background: isSelected ? C.gold : C.borderHi,
                          minHeight: '2px',
                        }} title={`${d.date}: ${formatUSD(d.usd)}`} />
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '9px',
                          color: isSelected ? C.gold : C.textDim,
                        }}>{d.date.slice(8, 10)}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>

        {/* ─── Sprint 11: Quality scores panel ────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>QUALITY SCORES · {selectedDate}</div>
            <button onClick={triggerScoring} disabled={scoring} style={{
              background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
              padding: '10px 16px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2px',
              cursor: scoring ? 'not-allowed' : 'pointer',
              opacity: scoring ? 0.5 : 1, minHeight: '44px',
            }}>{scoring ? 'SCORING…' : 'RUN SCORING NOW'}</button>
          </div>

          {scoreResult && (
            <div style={{
              padding: '10px 14px', marginBottom: '16px',
              border: `1px solid ${scoreResult.startsWith('Failed') || scoreResult.startsWith('Error') ? C.err : C.border}`,
              background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px',
              color: scoreResult.startsWith('Failed') || scoreResult.startsWith('Error') ? C.err : C.textSoft,
            }}>{scoreResult}</div>
          )}

          {scoresToday.length === 0 && (
            <div style={{
              border: `1px solid ${C.border}`, padding: '20px', color: C.textMute,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
              background: C.surface2, fontStyle: 'italic',
            }}>
              No scores yet for {selectedDate}. Click "Run Scoring Now" — uses gpt-4o-mini to score all 3 ready editions against the 7-dim rubric (~$0.005, 10-20s).
            </div>
          )}

          {scoresToday.length > 0 && (
            <div style={{ border: `1px solid ${C.border}`, background: C.surface2, overflowX: 'auto' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1.6fr repeat(7, 0.5fr) 0.7fr',
                gap: '8px', padding: '12px 14px', borderBottom: `1px solid ${C.border}`,
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.2px', color: C.textMute, minWidth: '560px',
              }}>
                <div>EDITION</div>
                <div style={{ textAlign: 'center' }} title="Coverage">COV</div>
                <div style={{ textAlign: 'center' }} title="Field Completeness">FLD</div>
                <div style={{ textAlign: 'center' }} title="India Anchor">IND</div>
                <div style={{ textAlign: 'center' }} title="Source Quality">SRC</div>
                <div style={{ textAlign: 'center' }} title="Editorial Sharpness">EDT</div>
                <div style={{ textAlign: 'center' }} title="Currentness">CUR</div>
                <div style={{ textAlign: 'center' }} title="Relevance">REL</div>
                <div style={{ textAlign: 'right' }}>TOTAL</div>
              </div>
              {scoresToday.map(s => (
                <div key={s.edition} style={{
                  display: 'grid', gridTemplateColumns: '1.6fr repeat(7, 0.5fr) 0.7fr',
                  gap: '8px', padding: '14px',
                  borderBottom: `1px solid ${C.border}`,
                  fontFamily: "'DM Mono', monospace", fontSize: '13px',
                  alignItems: 'center', minWidth: '560px',
                }}>
                  <div style={{ fontFamily: "'Playfair Display', serif", fontSize: '15px', fontWeight: 700, color: C.text }}>
                    {s.edition === '5min' ? 'The Brief' : s.edition === '10min' ? 'The Daily' : 'The Editorial'}
                  </div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_coverage) }}>{s.dim_coverage ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_field_completeness) }}>{s.dim_field_completeness ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_india_anchor) }}>{s.dim_india_anchor ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_source_quality) }}>{s.dim_source_quality ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_editorial_sharpness) }}>{s.dim_editorial_sharpness ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_currentness) }}>{s.dim_currentness ?? '—'}</div>
                  <div style={{ textAlign: 'center', color: scoreColor(s.dim_relevance) }}>{s.dim_relevance ?? '—'}</div>
                  <div style={{ textAlign: 'right', fontSize: '14px', fontWeight: 700, color: totalColor(s.total) }}>
                    {s.total ?? '—'}/{s.max_score}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Scorer notes */}
          {scoresToday.filter(s => s.notes).length > 0 && (
            <div style={{ marginTop: '16px' }}>
              {scoresToday.filter(s => s.notes).map(s => (
                <div key={`notes-${s.edition}`} style={{ marginBottom: '12px' }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '1.5px', color: C.textMute, marginBottom: '4px',
                  }}>{s.edition === '5min' ? 'BRIEF' : s.edition === '10min' ? 'DAILY' : 'EDITORIAL'} · SCORER NOTES</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                    color: C.textSoft, lineHeight: 1.55, fontStyle: 'italic',
                  }}>{s.notes}</div>
                </div>
              ))}
            </div>
          )}

          {/* 7-day score trend */}
          {scores7d.length > 0 && (() => {
            const groups: Record<string, ScoreRow[]> = { '5min': [], '10min': [], 'deep': [] }
            for (const s of scores7d) {
              if (groups[s.edition]) groups[s.edition].push(s)
            }
            return (
              <div style={{ marginTop: '24px' }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '2px', color: C.textMute, marginBottom: '12px',
                }}>8-DAY AVERAGES</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {(['5min', '10min', 'deep'] as const).map(ed => {
                    const pts = groups[ed]
                    const avg = pts.length > 0 ? pts.reduce((s, p) => s + (p.total || 0), 0) / pts.length : 0
                    return (
                      <div key={ed} style={{
                        border: `1px solid ${C.border}`, background: C.surface2, padding: '14px',
                      }}>
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '10px',
                          letterSpacing: '1.5px', color: C.textMute, marginBottom: '6px',
                        }}>{ed === '5min' ? 'BRIEF' : ed === '10min' ? 'DAILY' : 'EDITORIAL'}</div>
                        <div style={{
                          fontFamily: "'Playfair Display', serif", fontSize: '24px',
                          fontWeight: 700, color: totalColor(avg), lineHeight: 1.1,
                        }}>
                          {avg > 0 ? avg.toFixed(1) : '—'}
                          <span style={{ fontSize: '13px', color: C.textMute }}>/70</span>
                        </div>
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '10px',
                          color: C.textDim, marginTop: '4px',
                        }}>{pts.length} day{pts.length === 1 ? '' : 's'} sampled</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>

        {/* ─── Sprint 11: Tail status panel ───────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
          }}>TAIL STATUS · PERSONALISATION HEALTH</div>

          {Object.keys(tailCounts).length === 0 ? (
            <div style={{
              border: `1px solid ${C.border}`, padding: '20px', color: C.textMute,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
              background: C.surface2, fontStyle: 'italic',
            }}>
              No personalised briefs produced for {selectedDate} yet. Tail status is logged from Sprint 11 onwards.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {(['ok', 'partial_city_failed', 'partial_interest_failed', 'partial_both'] as const).map(status => {
                const n = tailCounts[status] || 0
                const label =
                  status === 'ok' ? 'HEALTHY' :
                  status === 'partial_city_failed' ? 'CITY FAIL' :
                  status === 'partial_interest_failed' ? 'INTEREST FAIL' : 'BOTH FAIL'
                const colour =
                  status === 'ok' ? C.ok :
                  status === 'partial_both' ? C.err : C.warn
                return (
                  <div key={status} style={{
                    border: `1px solid ${C.border}`, padding: '14px',
                    background: C.surface2, borderLeft: `3px solid ${colour}`,
                  }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px', color: colour, marginBottom: '6px',
                    }}>{label}</div>
                    <div style={{
                      fontFamily: "'Playfair Display', serif", fontSize: '22px',
                      fontWeight: 700, color: colour,
                    }}>{n}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ─── Sprint 11: Today's call log ────────────────────────────── */}
        {costsToday.length > 0 && (
          <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
            }}>CALL LOG · {selectedDate}</div>
            <div style={{
              border: `1px solid ${C.border}`, background: C.surface2,
              maxHeight: '320px', overflowY: 'auto',
            }}>
              {costsToday.slice().reverse().map(r => {
                const t = new Date(r.created_at)
                const istT = new Date(t.getTime() + 5.5 * 60 * 60 * 1000)
                const hhmm = istT.toISOString().slice(11, 16)
                return (
                  <div key={r.id} style={{
                    display: 'grid', gridTemplateColumns: '0.5fr 0.7fr 0.8fr 1fr 0.5fr',
                    gap: '10px', padding: '10px 14px',
                    borderBottom: `1px solid ${C.border}`,
                    fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    alignItems: 'center',
                  }}>
                    <div style={{ color: C.textMute }}>{hhmm}</div>
                    <div style={{ color: C.gold, letterSpacing: '1px' }}>{r.phase.toUpperCase()}</div>
                    <div style={{ color: C.textSoft }}>{r.model}</div>
                    <div style={{ color: C.textSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || '—'}</div>
                    <div style={{ color: C.text, textAlign: 'right', fontWeight: 600 }}>{formatUSD(Number(r.usd_cost))}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </>
  )
}

function CenteredMsg({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: C.bg, display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '28px',
    }}>{children}</div>
  )
}
