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
      const res = await fetch('/api/generate-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition, skipPush: true }),
      })
      const data = await res.json()
      setRegenResult(JSON.stringify(data.results || data, null, 2))
      await loadBriefs()
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
      const res = await fetch('/api/personalise-briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      setPersonaliseResult(JSON.stringify(data, null, 2))
      await loadPersonalisedStats()
    } catch (e: any) {
      setPersonaliseResult('Error: ' + e.message)
    }
    setRunningPersonalisation(false)
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
          }}>{regenerating ? 'GENERATING… (60–120s)' : 'REGENERATE ALL 3 EDITIONS'}</button>

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
