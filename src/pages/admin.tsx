import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Admin page ──────────────────────────────────────────────────────────────
// Sprint 8 — shows today's status across all 3 editions.
// Sprint 12.5.1 — reorganised flow + master pipeline button.
//
// New panel order matches the production pipeline sequence:
//   1. Briefs (fetch + write 3 editions)
//   2. Personalisation
//   3. Tail-fetch (city/interest/industry stories for personalised editions)
//   4. Quality scoring
//   5. Cost log
//
// A new "RUN FULL PIPELINE" button at the top runs all 5 stages sequentially
// in a single click, with per-stage live status. The existing per-stage
// buttons are preserved as manual escape hatches.

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
// Sprint 13: every admin API call carries the logged-in user's supabase
// session token. The API routes accept it once CRON_SECRET enforcement is on
// (cron jobs use the secret; the admin browser uses the session token).
async function authHeader(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  } catch { return {} }
}

async function safeJsonFetch(url: string, init?: RequestInit): Promise<any> {
  let res: Response
  try {
    const auth = await authHeader()
    res = await fetch(url, { ...init, headers: { ...auth, ...((init?.headers as Record<string, string>) || {}) } })
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

// Sprint 12.5.1: extract hostname for publisher diversity check.
// Mirrors the logic in src/lib/whitelist.ts but kept inline so admin.tsx
// has no extra import surface. Stripped: www., m., amp. subdomain prefixes.
function extractHost(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^m\./, '')
      .replace(/^amp\./, '')
  } catch {
    return null
  }
}

// Walk a brief's raw_stories or content sections and return every source_url
// found. Used by the Top Publishers panel.
function collectSourceUrls(content: any): string[] {
  if (!content || typeof content !== 'object') return []
  const urls: string[] = []
  const SECTION_KEYS = [
    'major_events', 'world', 'india', 'business', 'technology',
    'climate_health', 'sport', 'culture', 'topics',
    'bengaluru', 'delhi', 'three_patterns', 'watching_this_week',
  ]
  for (const k of SECTION_KEYS) {
    const arr = content[k]
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s && typeof s === 'object' && s.source_url) urls.push(s.source_url)
      }
    } else if (arr && typeof arr === 'object' && arr.source_url) {
      // sport/culture sometimes single object
      urls.push(arr.source_url)
    }
  }
  // long_read inside Editorial
  if (content.long_read?.source_url) urls.push(content.long_read.source_url)
  return urls
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

// Sprint 12 — one row per (date, tail_type, tail_key) from tail_briefs table.
type TailBriefRow = {
  tail_type: 'city' | 'interest' | 'industry'
  tail_key: string
  display_name: string
  status: 'ready' | 'empty' | 'failed'
  story_count: number
  used_regional: boolean
  reason: string | null
}

// Sprint 14 — Desks panel rows: catalog joined to today's edition, score,
// and subscriber count at render time.
type DeskAdminRow = {
  slug: string
  name: string
  emoji: string
  status: string
  sort_order: number
}

type DeskEditionAdminRow = {
  desk_slug: string
  status: 'ready' | 'thin' | 'failed'
  generated_at: string | null
  content: any
}

// Sprint 12.5.1: master pipeline stage tracking. Each stage in the full
// pipeline reports its status independently so the operator can see exactly
// where things stand and where they failed.
type StageId = 'fetch' | 'write' | 'personalise' | 'tail' | 'storylines' | 'score' | 'desks' | 'extras'
type StageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
type StageState = {
  id: StageId
  label: string
  status: StageStatus
  detail: string
  startedAt?: number
  endedAt?: number
}

const STAGE_DEFS: { id: StageId; label: string }[] = [
  { id: 'fetch',       label: '1 · Fetch news' },
  { id: 'write',       label: '2 · Write 3 editions' },
  { id: 'personalise', label: '3 · Personalise per user' },
  { id: 'tail',        label: '4 · Tail-fetch (city/interest/industry)' },
  { id: 'storylines',  label: '5 · Storylines (tag/create/update)' },
  { id: 'score',       label: '6 · Quality scoring' },
  { id: 'desks',       label: '7 · Desks (subscribed only)' },
  { id: 'extras',      label: '8 · Score personalised + storylines' },
]

function emptyStages(): StageState[] {
  return STAGE_DEFS.map(s => ({ id: s.id, label: s.label, status: 'pending', detail: '' }))
}

function stageColor(s: StageStatus): string {
  if (s === 'ok') return C.ok
  if (s === 'failed') return C.err
  if (s === 'running') return C.gold
  if (s === 'skipped') return C.textDim
  return C.textMute
}

function stageGlyph(s: StageStatus): string {
  if (s === 'ok') return '✓'
  if (s === 'failed') return '✗'
  if (s === 'running') return '·'
  if (s === 'skipped') return '–'
  return '○'
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

// Friendly label for fetch source (raw_stories._source).
function fetchSourceLabel(s: string | null | undefined): { label: string; colour: string } {
  if (!s) return { label: 'UNKNOWN', colour: C.textMute }
  if (s === 'perplexity') return { label: 'PERPLEXITY · SINGLE', colour: C.ok }
  if (s === 'perplexity-retry') return { label: 'PERPLEXITY · RETRY', colour: C.warn }
  if (s === 'perplexity-2phase') return { label: 'PERPLEXITY · 2-PHASE (B)', colour: C.ok }
  if (s === 'gpt-4o-fallback') return { label: 'GPT-4O FALLBACK ⚠', colour: C.warn }
  if (s === 'gpt4o-2phase') return { label: 'GPT-4O · 2-PHASE (C)', colour: C.gold }
  return { label: s.toUpperCase(), colour: C.textSoft }
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

  // Sprint 12 — tail-fetch state
  const [runningTailFetch, setRunningTailFetch] = useState(false)
  const [tailFetchResult, setTailFetchResult] = useState<string>('')
  const [tailBriefRows, setTailBriefRows] = useState<TailBriefRow[]>([])

  // Sprint 12.5.1 — master pipeline state
  const [masterRunning, setMasterRunning] = useState(false)
  // Sprint 13: storylines panel state.
  const [storylineRows, setStorylineRows] = useState<any[]>([])
  const [storylineCounts, setStorylineCounts] = useState<{ events: Record<string, number>; follows: Record<string, number> }>({ events: {}, follows: {} })
  const [storylineRunning, setStorylineRunning] = useState(false)
  const [storylineResult, setStorylineResult] = useState<string>('')

  // Sprint 14: Desks panel state.
  const [deskRows, setDeskRows] = useState<DeskAdminRow[]>([])
  const [deskEditions, setDeskEditions] = useState<Record<string, DeskEditionAdminRow>>({})
  const [deskSubCounts, setDeskSubCounts] = useState<Record<string, number>>({})
  const [desksRunning, setDesksRunning] = useState(false)
  const [desksResult, setDesksResult] = useState<string>('')

  // Sprint 14: one-click data export (for sharing back during testing).
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<string>('')

  const [masterStages, setMasterStages] = useState<StageState[]>(emptyStages())
  const [masterFinishedAt, setMasterFinishedAt] = useState<number | null>(null)

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
      loadStorylines()
      loadTailBriefsStatus()
      loadDesksPanel()
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
        // invocations to stay under the 300s function timeout:
        //   1. mode=fetch  — fetch news + lens (~35-45s)
        //   2. mode=write  — three parallel writes (~15-30s each)
        // Each call is its own function invocation with its own 300s budget.

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
      await loadTailBriefsStatus()
    } catch (e: any) {
      setPersonaliseResult('Error: ' + e.message)
    }
    setRunningPersonalisation(false)
  }

  // Sprint 12: trigger the tail-fetch phase manually.
  async function runTailFetch() {
    setRunningTailFetch(true)
    setTailFetchResult('Running tail-fetch (cities + interests + industries via gpt-4o-mini-search-preview)…')
    try {
      const data = await safeJsonFetch('/api/generate-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'tail-fetch' }),
      })
      setTailFetchResult(JSON.stringify(data, null, 2))
      await loadTailBriefsStatus()
      await loadCostAndScoreData()
    } catch (e: any) {
      setTailFetchResult('Error: ' + e.message)
    }
    setRunningTailFetch(false)
  }

  // Sprint 12: load tail_briefs status rows for the selected date.
  async function loadTailBriefsStatus() {
    const { data, error } = await supabase
      .from('tail_briefs')
      .select('tail_type, tail_key, display_name, status, story_count, used_regional, reason')
      .eq('date', selectedDate)
      .order('tail_type')
      .order('tail_key')
    if (error) {
      setTailBriefRows([])
      return
    }
    setTailBriefRows((data || []) as TailBriefRow[])
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

  // Sprint 13: load storylines + per-storyline event/follower counts.
  async function loadStorylines() {
    const { data: lines } = await supabase
      .from('storylines')
      .select('id, slug, title, story_so_far, confidence, status, origin, last_event_at')
      .order('status', { ascending: true })
      .order('last_event_at', { ascending: false })
      .limit(60)
    setStorylineRows(lines || [])
    const ids = (lines || []).map((l: any) => l.id)
    if (ids.length === 0) { setStorylineCounts({ events: {}, follows: {} }); return }
    const [{ data: evs }, { data: fls }] = await Promise.all([
      supabase.from('storyline_events').select('storyline_id').in('storyline_id', ids),
      supabase.from('storyline_follows').select('storyline_id').in('storyline_id', ids),
    ])
    const events: Record<string, number> = {}
    for (const e of (evs || []) as any[]) events[e.storyline_id] = (events[e.storyline_id] || 0) + 1
    const follows: Record<string, number> = {}
    for (const f of (fls || []) as any[]) follows[f.storyline_id] = (follows[f.storyline_id] || 0) + 1
    setStorylineCounts({ events, follows })
  }

  async function runStorylines() {
    setStorylineRunning(true)
    setStorylineResult('Running storylines stage…')
    try {
      const data = await safeJsonFetch('/api/generate-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'storylines' }),
      })
      if (data.ok) {
        setStorylineResult(`Done. tagged=${data.tagged} created=${data.created} fallback=${data.fallback_hits}/${data.fallback_checked} regen=${data.regenerated} dormant=${data.dormant_marked} concluded=${data.concluded_marked}`)
        await loadStorylines()
      } else {
        setStorylineResult('Failed: ' + (data.error || JSON.stringify(data)))
      }
    } catch (e: any) {
      setStorylineResult('Error: ' + e.message)
    }
    setStorylineRunning(false)
  }

  // ─── Sprint 14: Desks panel loaders + runner ───────────────────────────

  // Catalog + per-desk edition (selected date) + subscriber counts.
  async function loadDesksPanel() {
    const [{ data: desks }, { data: editions }, { data: subs }] = await Promise.all([
      supabase.from('desks')
        .select('slug, name, emoji, status, sort_order')
        .order('sort_order', { ascending: true }),
      supabase.from('desk_editions')
        .select('desk_slug, status, generated_at, content')
        .eq('date', selectedDate),
      supabase.from('desk_subscriptions').select('desk_slug'),
    ])
    setDeskRows((desks || []) as DeskAdminRow[])
    const edMap: Record<string, DeskEditionAdminRow> = {}
    for (const e of (editions || []) as DeskEditionAdminRow[]) edMap[e.desk_slug] = e
    setDeskEditions(edMap)
    const counts: Record<string, number> = {}
    for (const s of (subs || []) as any[]) counts[s.desk_slug] = (counts[s.desk_slug] || 0) + 1
    setDeskSubCounts(counts)
  }

  function deskEditionStoryCount(content: any): number {
    if (!content) return 0
    return ['top_stories', 'india', 'global', 'features', 'quick_takes']
      .reduce((n, k) => n + (Array.isArray(content[k]) ? content[k].length : 0), 0)
  }

  async function runDesksNow(slug?: string) {
    setDesksRunning(true)
    setDesksResult(slug
      ? `Force-running ${slug} desk (2 search fetches + write + score, ~60-90s)…`
      : 'Running desks (subscribed desks lacking today\'s edition, concurrency 2)…')
    try {
      const data = await safeJsonFetch('/api/generate-desks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slug ? { desk: slug } : {}),
      })
      if (data.ok) {
        const s = data.summary || {}
        const processedNames = (data.processed || []).map((r: any) => `${r.slug}:${r.status}`).join(' ')
        setDesksResult(
          `Done in ${data.elapsed_s ?? '?'}s. ready=${s.ready ?? 0} thin=${s.thin ?? 0} failed=${s.failed ?? 0} deferred=${s.deferred ?? 0}`
          + (processedNames ? ` · ${processedNames}` : '')
          + (data.note ? ` · ${data.note}` : '')
        )
        await loadDesksPanel()
        await loadCostAndScoreData()
      } else {
        setDesksResult('Failed: ' + (data.error || JSON.stringify(data)))
      }
    } catch (e: any) {
      setDesksResult('Error: ' + e.message)
    }
    setDesksRunning(false)
  }

  // ─── Sprint 14: one-click export ───────────────────────────────────────
  // Pulls every relevant table in one request and downloads it as a single
  // JSON file, so the whole dataset can be shared back in one step instead of
  // exporting each Supabase table by hand. days=0 means all-time.
  async function exportAllData(days: number) {
    setExporting(true)
    setExportResult('Gathering data…')
    try {
      const qs = days === 0 ? 'days=all' : `days=${days}`
      const data = await safeJsonFetch(`/api/admin-export?${qs}`, { method: 'GET' })
      if (!data?.ok) {
        setExportResult('Failed: ' + (data?.error || 'export returned ok=false'))
        setExporting(false)
        return
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      a.download = `morning-brief-export-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      const totalRows = Object.values(data.counts || {}).reduce((n: number, v: any) => n + (Number(v) || 0), 0)
      setExportResult(`Downloaded · ${totalRows} rows · ${data.window}`)
    } catch (e: any) {
      setExportResult('Failed: ' + (e?.message || e))
    }
    setExporting(false)
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

  // ─── Sprint 12.5.1: full pipeline orchestration ─────────────────────────
  // Sequence (each is its own Vercel invocation with its own 300s budget):
  //   1. fetch         POST /api/generate-brief {mode:'fetch'}
  //   2. write x3      POST /api/generate-brief {mode:'write', edition: <e>}   (parallel)
  //   3. personalise   POST /api/personalise-briefs
  //   4. tail-fetch    POST /api/generate-brief {mode:'tail-fetch'}
  //   5. storylines    POST /api/generate-brief {mode:'storylines'}   (Sprint 13)
  //   6. score         POST /api/generate-brief {mode:'score'}
  //
  // Each stage updates masterStages so the operator can see progress live.
  // On stage failure the pipeline stops and downstream stages are marked
  // 'skipped' rather than 'pending' — so the partial state is unambiguous.
  async function runFullPipeline() {
    setMasterRunning(true)
    setMasterFinishedAt(null)
    let stages: StageState[] = emptyStages()
    setMasterStages(stages)

    const setStage = (id: StageId, patch: Partial<StageState>) => {
      stages = stages.map(s => s.id === id ? { ...s, ...patch } : s)
      setMasterStages(stages)
    }

    const skipRemaining = (afterId: StageId) => {
      const order: StageId[] = ['fetch', 'write', 'personalise', 'tail', 'storylines', 'score', 'desks', 'extras']
      const idx = order.indexOf(afterId)
      for (let i = idx + 1; i < order.length; i++) {
        setStage(order[i], { status: 'skipped', detail: 'skipped — upstream stage failed' })
      }
    }

    const pipelineStart = Date.now()

    try {
      // ─── Stage 1: fetch ──────────────────────────────────────────────
      setStage('fetch', { status: 'running', detail: 'fetching news (~40s)…', startedAt: Date.now() })
      let fetchData: any
      try {
        fetchData = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'fetch' }),
        })
      } catch (e: any) {
        setStage('fetch', { status: 'failed', detail: e.message, endedAt: Date.now() })
        skipRemaining('fetch')
        return
      }
      if (!fetchData?.ok) {
        setStage('fetch', { status: 'failed', detail: fetchData?.error || 'fetch returned ok=false', endedAt: Date.now() })
        skipRemaining('fetch')
        return
      }
      const sec = fetchData?.sections || {}
      const sourceTag = fetchData?.source || fetchData?.fetch_source || ''
      const sourceFragment = sourceTag ? ` · via ${sourceTag}` : ''
      setStage('fetch', {
        status: 'ok',
        detail: `major=${sec.major_events ?? '?'}, world=${sec.world ?? '?'}, india=${sec.india ?? '?'}${sourceFragment}`,
        endedAt: Date.now(),
      })
      await loadBriefs()

      // ─── Stage 2: write 3 editions in parallel ───────────────────────
      setStage('write', { status: 'running', detail: 'writing 5min, 10min, deep…', startedAt: Date.now() })
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
      const writeOK = writeResults.filter((r: any) => r?.ok).length
      const writeFailed = writeResults.length - writeOK
      if (writeFailed === writeResults.length) {
        setStage('write', { status: 'failed', detail: 'all 3 writers failed', endedAt: Date.now() })
        skipRemaining('write')
        return
      }
      setStage('write', {
        status: writeFailed === 0 ? 'ok' : 'ok',
        detail: writeFailed === 0
          ? `${writeOK}/3 editions ready`
          : `${writeOK}/3 editions ready · ${writeFailed} failed (continuing)`,
        endedAt: Date.now(),
      })
      await loadBriefs()

      // ─── Stage 3: personalise ────────────────────────────────────────
      setStage('personalise', { status: 'running', detail: 'building personalised editions per user…', startedAt: Date.now() })
      let personaliseData: any
      try {
        personaliseData = await safeJsonFetch('/api/personalise-briefs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      } catch (e: any) {
        setStage('personalise', { status: 'failed', detail: e.message, endedAt: Date.now() })
        // Personalisation failure does NOT skip downstream — tail-fetch and
        // scoring still produce useful diagnostic output. Just continue.
        personaliseData = null
      }
      if (personaliseData) {
        const userCount = personaliseData?.users_processed ?? personaliseData?.users ?? '?'
        const readyCount = personaliseData?.ready ?? personaliseData?.editions_ready ?? '?'
        setStage('personalise', {
          status: 'ok',
          detail: `users=${userCount}, ready=${readyCount}`,
          endedAt: Date.now(),
        })
      }
      await loadPersonalisedStats()

      // ─── Stage 4: tail-fetch ─────────────────────────────────────────
      setStage('tail', { status: 'running', detail: 'fetching per-city / per-interest / per-industry stories…', startedAt: Date.now() })
      let tailData: any
      try {
        tailData = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'tail-fetch' }),
        })
      } catch (e: any) {
        setStage('tail', { status: 'failed', detail: e.message, endedAt: Date.now() })
        tailData = null
      }
      if (tailData) {
        const s = tailData?.summary || {}
        const c = s.cities      ? `${s.cities.ready ?? '?'}/${s.cities.total ?? '?'}` : '?'
        const i = s.interests   ? `${s.interests.ready ?? '?'}/${s.interests.total ?? '?'}` : '?'
        const d = s.industries  ? `${s.industries.ready ?? '?'}/${s.industries.total ?? '?'}` : '?'
        setStage('tail', {
          status: 'ok',
          detail: `cities ${c} · interests ${i} · industries ${d}`,
          endedAt: Date.now(),
        })
      }
      await loadTailBriefsStatus()

      // ─── Stage 5: storylines (Sprint 13) ─────────────────────────────
      setStage('storylines', { status: 'running', detail: 'tagging stories, creating storylines, fetching updates…', startedAt: Date.now() })
      try {
        const slData = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'storylines' }),
        })
        if (slData?.ok) {
          setStage('storylines', {
            status: 'ok',
            detail: `tagged=${slData.tagged ?? '?'} created=${slData.created ?? '?'} fallback=${slData.fallback_hits ?? '?'}/${slData.fallback_checked ?? '?'} regen=${slData.regenerated ?? '?'}`,
            endedAt: Date.now(),
          })
        } else {
          setStage('storylines', { status: 'failed', detail: slData?.error || 'storylines returned ok=false', endedAt: Date.now() })
        }
      } catch (e: any) {
        // Storyline failure does NOT block scoring — continue.
        setStage('storylines', { status: 'failed', detail: e.message, endedAt: Date.now() })
      }
      await loadStorylines()

      // ─── Stage 6: score ──────────────────────────────────────────────
      setStage('score', { status: 'running', detail: 'scoring all 3 editions on 7-dim rubric…', startedAt: Date.now() })
      try {
        const scoreData = await safeJsonFetch('/api/generate-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'score' }),
        })
        if (scoreData?.ok) {
          setStage('score', { status: 'ok', detail: 'rubric written to brief_scores', endedAt: Date.now() })
        } else {
          setStage('score', { status: 'failed', detail: scoreData?.error || 'score returned ok=false', endedAt: Date.now() })
        }
      } catch (e: any) {
        setStage('score', { status: 'failed', detail: e.message, endedAt: Date.now() })
      }
      await loadCostAndScoreData()

      // ─── Stage 7: desks (Sprint 14) ──────────────────────────────────
      // Independent of the brief — processes only subscribed desks lacking
      // today's edition (concurrency 2, ~200s start budget). In production
      // this also runs on its own cron twice (06:20 + 06:27); the button
      // runs it once here for convenience.
      setStage('desks', { status: 'running', detail: 'generating subscribed desks…', startedAt: Date.now() })
      try {
        const deskData = await safeJsonFetch('/api/generate-desks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (deskData?.ok) {
          const s = deskData.summary || {}
          const hasWork = (deskData.processed || []).length > 0 || (deskData.deferred || []).length > 0
          setStage('desks', {
            status: 'ok',
            detail: hasWork
              ? `ready=${s.ready ?? 0} thin=${s.thin ?? 0} failed=${s.failed ?? 0} deferred=${s.deferred ?? 0}`
              : (deskData.note || 'no subscribed desks to generate'),
            endedAt: Date.now(),
          })
        } else {
          setStage('desks', { status: 'failed', detail: deskData?.error || 'desks returned ok=false', endedAt: Date.now() })
        }
      } catch (e: any) {
        setStage('desks', { status: 'failed', detail: e.message, endedAt: Date.now() })
      }
      await loadDesksPanel()

      // ─── Stage 8: extras — score personalised briefs + storylines ────
      setStage('extras', { status: 'running', detail: 'scoring personalised sample + storylines…', startedAt: Date.now() })
      try {
        const exData = await safeJsonFetch('/api/score-extras', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (exData?.ok) {
          const p = exData.personalised?.results ? Object.keys(exData.personalised.results).length : 0
          const s = exData.storylines?.results ? Object.keys(exData.storylines.results).length : 0
          setStage('extras', { status: 'ok', detail: `personalised editions=${p}, storylines=${s}`, endedAt: Date.now() })
        } else {
          setStage('extras', { status: 'failed', detail: exData?.error || 'extras returned ok=false', endedAt: Date.now() })
        }
      } catch (e: any) {
        setStage('extras', { status: 'failed', detail: e.message, endedAt: Date.now() })
      }
      await loadCostAndScoreData()
    } finally {
      setMasterFinishedAt(Date.now())
      setMasterRunning(false)
    }

    // Total elapsed log — useful when the operator screenshots the panel.
    const elapsedSec = Math.round((Date.now() - pipelineStart) / 1000)
    console.log(`[admin] Full pipeline finished in ${elapsedSec}s.`)
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

  // ─── Derived view data (computed each render — cheap) ────────────────────
  // Fetch source: pulled from any of today's brief rows' raw_stories._source.
  // All 3 editions share the same fetch result, so any row will do.
  const fetchSource: string | null = (() => {
    for (const r of rows) {
      const s = r?.raw_stories?._source
      if (s) return s
    }
    return null
  })()

  // Top publishers: counts per host across all today's brief content.
  const topPublishers: { host: string; count: number }[] = (() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      for (const u of collectSourceUrls(r.content)) {
        const h = extractHost(u)
        if (h) counts.set(h, (counts.get(h) || 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([host, count]) => ({ host, count }))
  })()
  const totalStoryUrls = topPublishers.reduce((s, p) => s + p.count, 0)

  // Cost-per-user economics
  const todayTotalUSD = costsToday.reduce((s, r) => s + Number(r.usd_cost), 0)
  const usersPersonalised = personalisedToday.users || 0
  const costPerUserUSD = usersPersonalised > 0 ? todayTotalUSD / usersPersonalised : 0

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
          <button onClick={() => exportAllData(14)} disabled={exporting} style={{
            background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
            padding: '10px 14px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.5px', cursor: exporting ? 'not-allowed' : 'pointer',
            opacity: exporting ? 0.5 : 1, minHeight: '44px',
          }}>{exporting ? 'EXPORTING…' : '↓ EXPORT DATA (14d)'}</button>
          <button onClick={() => exportAllData(0)} disabled={exporting} style={{
            background: 'none', border: `1px solid ${C.border}`, color: C.textMute,
            padding: '10px 14px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.5px', cursor: exporting ? 'not-allowed' : 'pointer',
            opacity: exporting ? 0.5 : 1, minHeight: '44px',
          }}>ALL-TIME</button>
          {exportResult && (
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              color: exportResult.startsWith('Failed') ? C.err : C.textMute,
            }}>{exportResult}</span>
          )}
        </div>

        {/* ─── Sprint 12.5.1: MASTER PIPELINE PANEL ─────────────────────── */}
        {/* Sits between date picker and editions grid so it's the first
            action the operator sees. One click runs the full sequence in
            the order: brief → personalise → tail → score → cost log. */}
        <div style={{
          marginBottom: '36px', padding: '22px',
          border: `1px solid ${C.gold}`, background: C.surface,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: '14px', flexWrap: 'wrap', gap: '10px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>FULL PIPELINE · ONE CLICK</div>
            {masterFinishedAt && !masterRunning && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                color: C.textMute, letterSpacing: '1px',
              }}>
                LAST RUN ·&nbsp;
                {new Date(masterFinishedAt).toLocaleTimeString('en-IN', { hour12: false })}
              </div>
            )}
          </div>

          <div style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
            color: C.textSoft, lineHeight: 1.55, marginBottom: '18px',
          }}>
            Runs the full morning sequence in order: fetch news → write 3 editions →
            personalise per user → tail-fetch (city/interest/industry) → score on rubric →
            desks (subscribed only). Each stage is a separate Vercel invocation, so the
            300s timeout applies per stage, not to the whole pipeline.
          </div>

          <button onClick={runFullPipeline} disabled={masterRunning} style={{
            background: C.gold, color: '#0E0E0E', border: 'none',
            padding: '16px 28px', fontFamily: "'DM Mono', monospace", fontSize: '12px',
            letterSpacing: '2px', fontWeight: 700,
            cursor: masterRunning ? 'not-allowed' : 'pointer',
            opacity: masterRunning ? 0.6 : 1, minHeight: '52px',
            width: '100%',
          }}>{masterRunning ? 'RUNNING PIPELINE…' : 'RUN FULL PIPELINE NOW'}</button>

          {/* Per-stage progress display */}
          <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {masterStages.map((s) => {
              const dur = (s.startedAt && s.endedAt)
                ? `${Math.round((s.endedAt - s.startedAt) / 1000)}s`
                : (s.startedAt && masterRunning)
                  ? `${Math.round((Date.now() - s.startedAt) / 1000)}s…`
                  : ''
              return (
                <div key={s.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '28px 1.4fr 2fr 60px',
                  gap: '10px', alignItems: 'center',
                  padding: '10px 12px',
                  border: `1px solid ${C.border}`,
                  background: s.status === 'running' ? C.surface2 : C.surfaceDeep,
                  borderLeft: `3px solid ${stageColor(s.status)}`,
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '14px',
                    color: stageColor(s.status), textAlign: 'center', fontWeight: 700,
                  }}>{stageGlyph(s.status)}</div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    color: C.textSoft, letterSpacing: '1px',
                  }}>{s.label}</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                    color: s.status === 'failed' ? C.err : C.textMute,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={s.detail}>{s.detail || '—'}</div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    color: C.textDim, textAlign: 'right',
                  }}>{dur}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ─── PANEL 1: Briefs ─────────────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: '16px', flexWrap: 'wrap', gap: '10px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>BRIEFS · {selectedDate}</div>
            {fetchSource && (() => {
              const { label, colour } = fetchSourceLabel(fetchSource)
              return (
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  color: colour, letterSpacing: '1.5px',
                  padding: '4px 10px', border: `1px solid ${colour}`,
                }} title="The actual engine that produced today's fetch. PERPLEXITY = fast path. GPT-4O FALLBACK ⚠ = Perplexity 400'd or timed out and the safety net ran.">
                  {label}
                </div>
              )
            })()}
          </div>

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
          <div style={{ marginTop: '20px' }}>
            <button onClick={() => regenerate(undefined)} disabled={regenerating} style={{
              background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
              padding: '14px 22px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2px', fontWeight: 700,
              cursor: regenerating ? 'not-allowed' : 'pointer',
              opacity: regenerating ? 0.6 : 1, minHeight: '48px',
            }}>{regenerating ? 'GENERATING…' : 'REGENERATE ALL 3 EDITIONS'}</button>

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

          {/* Top publishers panel — diversity sanity check */}
          {topPublishers.length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.textMute, marginBottom: '10px',
              }}>TOP PUBLISHERS ACROSS TODAY&apos;S BRIEFS</div>
              <div style={{
                border: `1px solid ${C.border}`, background: C.surface2,
              }}>
                {topPublishers.map((p, i) => {
                  const pct = totalStoryUrls > 0 ? (p.count / totalStoryUrls) * 100 : 0
                  // Diversity guardrail: any single publisher >25% is a flag.
                  const flag = pct > 25
                  return (
                    <div key={p.host} style={{
                      display: 'grid',
                      gridTemplateColumns: '1.6fr 0.6fr 1fr',
                      gap: '10px', padding: '10px 14px',
                      borderBottom: i < topPublishers.length - 1 ? `1px solid ${C.border}` : 'none',
                      fontFamily: "'DM Mono', monospace", fontSize: '12px',
                      alignItems: 'center',
                    }}>
                      <div style={{ color: flag ? C.warn : C.textSoft }}>{p.host}</div>
                      <div style={{ color: C.text, textAlign: 'right' }}>{p.count}</div>
                      <div style={{
                        position: 'relative', height: '8px', background: C.surfaceDeep,
                        border: `1px solid ${C.border}`,
                      }}>
                        <div style={{
                          position: 'absolute', top: 0, left: 0, bottom: 0,
                          width: `${Math.min(100, pct)}%`,
                          background: flag ? C.warn : C.gold,
                        }} />
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                color: C.textDim, marginTop: '8px', letterSpacing: '0.5px',
              }}>
                {totalStoryUrls} source URLs across {rows.length} editions ·
                amber bar = single publisher &gt; 25% share
              </div>
            </div>
          )}
        </div>

        {/* ─── PANEL 2: Personalisation ─────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
          }}>PERSONALISATION · {selectedDate}</div>
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

          {/* Personalisation health (was: "Tail status" panel — moved here because
              it tracks personalised_briefs[].content.tail_status, which is a
              personalisation concern, not a tail-fetch concern). */}
          {Object.keys(tailCounts).length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.textMute, marginBottom: '10px',
              }}>PERSONALISATION HEALTH · PER-USER TAIL STATUS</div>
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
            </div>
          )}
        </div>

        {/* ─── PANEL 3: Tail-fetch ─────────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: '16px', flexWrap: 'wrap', gap: '12px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>TAIL-FETCH · CITY · INTEREST · INDUSTRY</div>
            <button onClick={runTailFetch} disabled={runningTailFetch} style={{
              padding: '8px 14px', background: 'transparent',
              color: runningTailFetch ? C.textDim : C.gold,
              border: `1px solid ${runningTailFetch ? C.border : C.gold}`,
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', cursor: runningTailFetch ? 'not-allowed' : 'pointer',
              textTransform: 'uppercase',
            }}>
              {runningTailFetch ? 'Running…' : 'Run tail-fetch now'}
            </button>
          </div>

          {tailBriefRows.length === 0 ? (
            <div style={{
              border: `1px solid ${C.border}`, padding: '20px', color: C.textMute,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
              background: C.surface2, fontStyle: 'italic',
            }}>
              No tail_briefs rows for {selectedDate} yet. Run tail-fetch (or wait for the cron).
            </div>
          ) : (
            <>
              {/* Summary cards by type */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '18px' }}>
                {(['city', 'interest', 'industry'] as const).map(type => {
                  const rows = tailBriefRows.filter(r => r.tail_type === type)
                  const ready = rows.filter(r => r.status === 'ready').length
                  const empty = rows.filter(r => r.status === 'empty').length
                  const failed = rows.filter(r => r.status === 'failed').length
                  return (
                    <div key={type} style={{
                      border: `1px solid ${C.border}`, padding: '12px 14px',
                      background: C.surface2,
                      borderLeft: `3px solid ${failed > 0 ? C.err : empty > 0 ? C.warn : C.ok}`,
                    }}>
                      <div style={{
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        letterSpacing: '1.5px', color: C.textMute, marginBottom: '6px',
                      }}>{type.toUpperCase()}</div>
                      <div style={{
                        fontFamily: "'Playfair Display', serif", fontSize: '20px',
                        fontWeight: 700, color: C.text, marginBottom: '4px',
                      }}>{ready}/{rows.length}</div>
                      <div style={{
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        color: C.textMute, letterSpacing: '0.5px',
                      }}>
                        {ready} ready · {empty} empty · {failed} failed
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Per-row breakdown */}
              <div style={{ border: `1px solid ${C.border}`, background: C.surface2, maxHeight: '320px', overflowY: 'auto' }}>
                {tailBriefRows.map((r, i) => {
                  const c =
                    r.status === 'ready' ? C.ok :
                    r.status === 'failed' ? C.err : C.warn
                  return (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '0.7fr 1.2fr 0.6fr 0.5fr 0.5fr',
                      gap: '10px', padding: '8px 14px',
                      borderBottom: i < tailBriefRows.length - 1 ? `1px solid ${C.border}` : 'none',
                      fontFamily: "'DM Mono', monospace", fontSize: '11px',
                      alignItems: 'center',
                    }}>
                      <div style={{ color: C.textMute, letterSpacing: '1px' }}>{r.tail_type}</div>
                      <div style={{ color: C.textSoft }}>{r.display_name}</div>
                      <div style={{ color: c, letterSpacing: '1px' }}>{r.status}</div>
                      <div style={{ color: C.text, textAlign: 'right' }}>{r.story_count} stories</div>
                      <div style={{ color: r.used_regional ? C.gold : C.textDim, textAlign: 'right' }}>
                        {r.tail_type === 'city' ? (r.used_regional ? 'regional' : 'national') : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {tailFetchResult && (
            <pre style={{
              marginTop: '16px', padding: '14px',
              background: C.surface2, border: `1px solid ${C.border}`,
              color: C.textSoft, fontFamily: "'DM Mono', monospace", fontSize: '11px',
              maxHeight: '220px', overflowY: 'auto', whiteSpace: 'pre-wrap',
            }}>{tailFetchResult}</pre>
          )}
        </div>

        {/* ─── PANEL: Storylines (Sprint 13) ───────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>STORYLINES · FOLLOW A STORY</div>
            <button onClick={runStorylines} disabled={storylineRunning} style={{
              background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
              padding: '10px 16px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2px',
              cursor: storylineRunning ? 'not-allowed' : 'pointer',
              opacity: storylineRunning ? 0.5 : 1, minHeight: '44px',
            }}>{storylineRunning ? 'RUNNING…' : 'RUN STORYLINES NOW'}</button>
          </div>

          {storylineResult && (
            <div style={{
              padding: '10px 14px', marginBottom: '16px',
              border: `1px solid ${storylineResult.startsWith('Failed') || storylineResult.startsWith('Error') ? C.err : C.border}`,
              background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px',
              color: storylineResult.startsWith('Failed') || storylineResult.startsWith('Error') ? C.err : C.textSoft,
            }}>{storylineResult}</div>
          )}

          {storylineRows.length === 0 ? (
            <div style={{
              padding: '18px', background: C.surface, border: `1px solid ${C.border}`,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: C.textMute,
            }}>
              No storylines yet. They appear after the first storylines run (auto-detected from the day's brief) or when a user follows a story.
            </div>
          ) : (
            <div style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              {storylineRows.map((l: any, i: number) => {
                const sc = l.status === 'active' ? C.ok : l.status === 'dormant' ? C.gold : C.textDim
                return (
                  <div key={l.id} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '12px 16px',
                    borderBottom: i < storylineRows.length - 1 ? `1px solid ${C.border}` : 'none',
                  }}>
                    <span style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '9px',
                      letterSpacing: '1px', color: sc, border: `1px solid ${sc}`,
                      borderRadius: '2px', padding: '3px 7px', whiteSpace: 'nowrap',
                    }}>{String(l.status || '').toUpperCase()}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                        color: C.text, fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {l.confidence === 'high' ? '📌 ' : ''}{l.title}
                      </div>
                      <div style={{
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        letterSpacing: '1px', color: C.textMute, marginTop: '2px',
                      }}>
                        {l.origin === 'user' ? 'USER' : 'AUTO'} · last event {l.last_event_at || '—'} · {l.story_so_far ? 'so-far ✓' : 'so-far pending'}
                      </div>
                    </div>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '11px',
                      color: C.textSoft, whiteSpace: 'nowrap',
                    }}>
                      {storylineCounts.events[l.id] || 0} ev · {storylineCounts.follows[l.id] || 0} fl
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div style={{
            marginTop: '10px', fontFamily: "'DM Mono', monospace",
            fontSize: '10px', letterSpacing: '1px', color: C.textDim,
          }}>
            CAPS · 25 ACTIVE · 5 NEW/DAY · 10 FALLBACK FETCHES/DAY · DORMANT AFTER 7 QUIET DAYS · CONCLUDED AFTER 30
          </div>
        </div>

        {/* ─── PANEL: Desks (Sprint 14) ────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2.5px', color: C.gold,
            }}>DESKS · {selectedDate}</div>
            <button onClick={() => runDesksNow()} disabled={desksRunning} style={{
              background: 'none', border: `1px solid ${C.gold}`, color: C.gold,
              padding: '10px 16px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '2px',
              cursor: desksRunning ? 'not-allowed' : 'pointer',
              opacity: desksRunning ? 0.5 : 1, minHeight: '44px',
            }}>{desksRunning ? 'RUNNING…' : 'RUN DESKS NOW'}</button>
          </div>

          {desksResult && (
            <div style={{
              padding: '10px 14px', marginBottom: '16px',
              border: `1px solid ${desksResult.startsWith('Failed') || desksResult.startsWith('Error') ? C.err : C.border}`,
              background: C.surface2,
              fontFamily: "'DM Mono', monospace", fontSize: '12px',
              color: desksResult.startsWith('Failed') || desksResult.startsWith('Error') ? C.err : C.textSoft,
            }}>{desksResult}</div>
          )}

          {deskRows.length === 0 ? (
            <div style={{
              padding: '18px', background: C.surface, border: `1px solid ${C.border}`,
              fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: C.textMute,
            }}>
              No desks in the catalog. Run sprint14_migration.sql in Supabase to create and seed the desks tables.
            </div>
          ) : (
            <div style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              {deskRows.map((d, i) => {
                const ed = deskEditions[d.slug]
                const subs = deskSubCounts[d.slug] || 0
                const score = scoresToday.find(s => s.edition === `desk:${d.slug}`)
                const stateColor =
                  !ed ? C.textDim :
                  ed.status === 'ready' ? C.ok :
                  ed.status === 'thin' ? C.warn : C.err
                const stateLabel =
                  !ed ? (subs === 0 ? 'NO SUBS · SKIPPED' : 'PENDING') :
                  ed.status.toUpperCase()
                const storyCount = ed ? deskEditionStoryCount(ed.content) : 0
                return (
                  <div key={d.slug} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '12px 16px',
                    borderBottom: i < deskRows.length - 1 ? `1px solid ${C.border}` : 'none',
                    flexWrap: 'wrap',
                  }}>
                    <span style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '9px',
                      letterSpacing: '1px', color: stateColor, border: `1px solid ${stateColor}`,
                      borderRadius: '2px', padding: '3px 7px', whiteSpace: 'nowrap',
                    }}>{stateLabel}</span>
                    <div style={{ flex: 1, minWidth: '140px' }}>
                      <div style={{
                        fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                        color: d.status === 'active' ? C.text : C.textDim, fontWeight: 600,
                      }}>
                        {d.emoji} {d.name}{d.status !== 'active' ? ' (hidden)' : ''}
                      </div>
                      <div style={{
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        letterSpacing: '1px', color: C.textMute, marginTop: '2px',
                      }}>
                        {subs} subscriber{subs === 1 ? '' : 's'}
                        {ed ? ` · ${storyCount} stories` : ''}
                        {ed?.generated_at ? ` · ${new Date(ed.generated_at).toLocaleTimeString('en-IN', { hour12: false })}` : ''}
                      </div>
                    </div>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '12px',
                      fontWeight: 700, whiteSpace: 'nowrap',
                      color: totalColor(score?.total ?? null),
                    }}>
                      {score?.total != null ? `${score.total}/70` : '—'}
                    </div>
                    <button onClick={() => runDesksNow(d.slug)} disabled={desksRunning} style={{
                      background: 'none', border: `1px solid ${C.border}`, color: C.textSoft,
                      padding: '8px 12px', fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px',
                      cursor: desksRunning ? 'not-allowed' : 'pointer',
                      opacity: desksRunning ? 0.5 : 1, minHeight: '40px',
                    }}>RE-RUN</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Desk scorer notes */}
          {scoresToday.filter(s => s.edition.startsWith('desk:') && s.notes).length > 0 && (
            <div style={{ marginTop: '16px' }}>
              {scoresToday.filter(s => s.edition.startsWith('desk:') && s.notes).map(s => (
                <div key={`desk-notes-${s.edition}`} style={{ marginBottom: '12px' }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '1.5px', color: C.textMute, marginBottom: '4px',
                  }}>{s.edition.slice('desk:'.length).toUpperCase()} DESK · SCORER NOTES</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                    color: C.textSoft, lineHeight: 1.55, fontStyle: 'italic',
                  }}>{s.notes}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{
            marginTop: '10px', fontFamily: "'DM Mono', monospace",
            fontSize: '10px', letterSpacing: '1px', color: C.textDim,
          }}>
            COST GATE · ONLY DESKS WITH ≥1 SUBSCRIBER RUN · ~$0.05/DESK/DAY · CRON HITS TWICE (06:20 + 06:27) — SECOND HIT SWEEPS DEFERRED DESKS
          </div>
        </div>

        {/* ─── PANEL 4: Quality Scores ─────────────────────────────────── */}
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
              No scores yet for {selectedDate}. Click "Run Scoring Now" — uses gpt-4o to score all 3 ready editions against the 7-dim rubric (~$0.06, 10-20s).
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
              {scoresToday.filter(s => !s.edition.startsWith('desk:')).map(s => (
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

          {/* Scorer notes (core editions only — desk notes live in the Desks panel) */}
          {scoresToday.filter(s => !s.edition.startsWith('desk:') && s.notes).length > 0 && (
            <div style={{ marginTop: '16px' }}>
              {scoresToday.filter(s => !s.edition.startsWith('desk:') && s.notes).map(s => (
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

        {/* ─── PANEL 5: Cost log ─────────────────────────────────────── */}
        <div style={{ marginTop: '36px', paddingTop: '28px', borderTop: `1px solid ${C.border}` }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2.5px', color: C.gold, marginBottom: '16px',
          }}>COST · {selectedDate}</div>

          <div style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '34px', fontWeight: 700, color: C.gold,
            lineHeight: 1.1, marginBottom: '4px',
          }}>{formatUSD(todayTotalUSD)}</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '12px',
            color: C.textMute, marginBottom: '20px',
          }}>
            ≈ {formatINR(todayTotalUSD)} · {costsToday.length} API call{costsToday.length === 1 ? '' : 's'}
          </div>

          {/* Cost-per-user economics — the unit-economics number Neha
              has been tracking. usd_today / personalised_users. Goes red when
              we're spending more than $0.20/user (Sprint 12 cost model
              committed to $0.02/user at scale). */}
          {usersPersonalised > 0 && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
              marginBottom: '20px',
            }}>
              <div style={{
                border: `1px solid ${C.border}`, padding: '14px', background: C.surface2,
                fontFamily: "'DM Mono', monospace", fontSize: '11px', color: C.textMute,
              }}>
                <div style={{ marginBottom: '6px', letterSpacing: '1.5px' }}>$ PER USER</div>
                <div style={{
                  fontFamily: "'Playfair Display', serif", fontSize: '20px',
                  fontWeight: 700,
                  color: costPerUserUSD < 0.05 ? C.ok : costPerUserUSD < 0.20 ? C.gold : C.warn,
                }}>
                  {formatUSD(costPerUserUSD)}
                </div>
                <div style={{ marginTop: '4px', color: C.textDim, fontSize: '10px' }}>
                  ≈ {formatINR(costPerUserUSD)} · target &lt; $0.02 at scale
                </div>
              </div>
              <div style={{
                border: `1px solid ${C.border}`, padding: '14px', background: C.surface2,
                fontFamily: "'DM Mono', monospace", fontSize: '11px', color: C.textMute,
              }}>
                <div style={{ marginBottom: '6px', letterSpacing: '1.5px' }}>PERSONALISED USERS</div>
                <div style={{
                  fontFamily: "'Playfair Display', serif", fontSize: '20px',
                  fontWeight: 700, color: C.text,
                }}>{usersPersonalised}</div>
                <div style={{ marginTop: '4px', color: C.textDim, fontSize: '10px' }}>
                  divisor for cost-per-user
                </div>
              </div>
            </div>
          )}

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

          {/* 8-day cost trend */}
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

          {/* Today's call log — kept inside the cost panel since both are
              the same logical block: today's $ + the underlying call ledger. */}
          {costsToday.length > 0 && (
            <div style={{ marginTop: '28px' }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.textMute, marginBottom: '10px',
              }}>CALL LOG</div>
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
