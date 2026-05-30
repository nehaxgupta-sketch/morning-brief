import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Admin page ──────────────────────────────────────────────────────────────
// Shows today's brief generation status across all 3 editions, with status
// badges, story counts, generated-at timestamp, and a manual regenerate
// button. Protected by ADMIN_EMAIL env var (set in Vercel env settings).
//
// To enable: in Vercel project settings, add an env var named
// NEXT_PUBLIC_ADMIN_EMAILS with a comma-separated list of allowed emails,
// e.g. "neha@example.com,partner@example.com".

type BriefRow = {
  date: string
  edition: string
  status: string
  generated_at: string | null
  content: any
  raw_stories: any
}

function getISTDate(offsetDays = 0): string {
  const now = new Date()
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000
  return new Date(istMs).toISOString().split('T')[0]
}

function statusColor(status: string) {
  if (status === 'ready') return '#4CAF7D'
  if (status === 'fallback') return '#E0A85C'
  if (status === 'failed') return '#E05C5C'
  return '#888'
}

function countStories(content: any): number {
  if (!content) return 0
  let n = 0
  for (const key of ['world', 'india', 'bengaluru', 'delhi', 'business', 'technology', 'climate_health']) {
    if (Array.isArray(content[key])) n += content[key].length
  }
  if (content.sport?.headline) n += 1
  if (content.culture?.headline) n += 1
  return n
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

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        window.location.href = '/login'
        return
      }
      const allowed = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      const userEmail = (user.email || '').toLowerCase()
      setEmail(userEmail)
      if (allowed.length === 0 || allowed.includes(userEmail)) {
        setAuthorized(true)
      } else {
        setAuthorized(false)
      }
    }
    checkAuth()
  }, [])

  useEffect(() => {
    if (authorized) loadBriefs()
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

  if (authorized === null) {
    return <CenteredMsg>Checking access…</CenteredMsg>
  }

  if (authorized === false) {
    return (
      <CenteredMsg>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: '22px', color: '#F5F1EA', marginBottom: '12px' }}>
          Not authorised
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '15px', color: '#888' }}>
          {email} doesn't have admin access.
        </div>
      </CenteredMsg>
    )
  }

  return (
    <>
      <Head><title>Admin — Morning Brief</title></Head>
      <div style={{ minHeight: '100vh', background: '#1A1A1A', padding: '32px 20px 80px', maxWidth: '900px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: '32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '6px' }}>
              MORNING BRIEF · ADMIN
            </div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '28px', fontWeight: 900, color: '#F5F1EA', margin: 0 }}>
              Brief Status
            </h1>
          </div>
          <Link href="/brief" style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px', color: '#888',
            textDecoration: 'none', border: '1px solid #2A2A2A', padding: '8px 14px',
          }}>
            ← BACK TO APP
          </Link>
        </div>

        {/* Date picker */}
        <div style={{ marginBottom: '24px', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '11px', color: '#888' }}>DATE:</span>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={{
              background: '#1E1E1E', border: '1px solid #2A2A2A', color: '#F5F1EA',
              padding: '8px 12px', fontFamily: "'DM Mono', monospace", fontSize: '13px',
            }}
          />
          <button
            onClick={() => setSelectedDate(getISTDate())}
            style={{
              background: 'none', border: '1px solid #2A2A2A', color: '#888',
              padding: '8px 12px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              cursor: 'pointer',
            }}
          >TODAY</button>
        </div>

        {/* Editions grid */}
        {loading ? (
          <div style={{ color: '#666', fontFamily: "'DM Mono', monospace", padding: '20px' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{
            border: '1px solid #2A2A2A', padding: '24px', color: '#888',
            fontFamily: "'DM Sans', sans-serif", marginBottom: '24px',
          }}>
            No briefs found for {selectedDate}. The cron may not have run yet, or the date might be in the future.
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.edition} style={{
              border: '1px solid #2A2A2A',
              borderLeft: `3px solid ${statusColor(row.status)}`,
              padding: '20px',
              marginBottom: '14px',
              background: '#1E1E1E',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                <div style={{
                  fontFamily: "'Playfair Display', serif", fontSize: '20px', fontWeight: 700, color: '#F5F1EA',
                }}>{row.edition.toUpperCase()}</div>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '11px', letterSpacing: '1.5px',
                  color: statusColor(row.status), textTransform: 'uppercase',
                }}>{row.status}</div>
              </div>

              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px',
                fontFamily: "'DM Mono', monospace", fontSize: '12px', color: '#999', marginBottom: '14px',
              }}>
                <div>stories: <span style={{ color: '#F5F1EA' }}>{countStories(row.content)}</span></div>
                <div>closer: <span style={{ color: '#F5F1EA' }}>{row.content?.closer ? 'yes' : 'no'}</span></div>
                <div>generated: <span style={{ color: '#F5F1EA' }}>{row.generated_at ? new Date(row.generated_at).toLocaleString('en-IN') : '—'}</span></div>
                <div>markets: <span style={{ color: '#F5F1EA' }}>{row.content?.markets?.indices?.length ?? 0} indices</span></div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setExpanded(expanded === row.edition ? null : row.edition)}
                  style={{
                    background: 'none', border: '1px solid #2A2A2A', color: '#888',
                    padding: '6px 12px', fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '1px', cursor: 'pointer',
                  }}
                >{expanded === row.edition ? 'HIDE JSON' : 'VIEW JSON'}</button>
                <button
                  onClick={() => regenerate(row.edition)}
                  disabled={regenerating}
                  style={{
                    background: 'none', border: '1px solid #C8A45A', color: '#C8A45A',
                    padding: '6px 12px', fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '1px', cursor: regenerating ? 'not-allowed' : 'pointer',
                    opacity: regenerating ? 0.5 : 1,
                  }}
                >REGENERATE</button>
              </div>

              {expanded === row.edition && (
                <pre style={{
                  marginTop: '14px', padding: '14px', background: '#0F0F0F',
                  border: '1px solid #2A2A2A', color: '#C0B9AF',
                  fontFamily: "'DM Mono', monospace", fontSize: '11px',
                  maxHeight: '400px', overflow: 'auto', whiteSpace: 'pre-wrap',
                }}>{JSON.stringify(row.content, null, 2)}</pre>
              )}
            </div>
          ))
        )}

        {/* Regenerate all */}
        <div style={{ marginTop: '32px', paddingTop: '24px', borderTop: '1px solid #2A2A2A' }}>
          <button
            onClick={() => regenerate(undefined)}
            disabled={regenerating}
            style={{
              background: '#C8A45A', color: '#1A1A1A', border: 'none',
              padding: '14px 24px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '1.5px', fontWeight: 700, cursor: regenerating ? 'not-allowed' : 'pointer',
              opacity: regenerating ? 0.6 : 1,
            }}
          >{regenerating ? 'GENERATING… (60-120s)' : 'REGENERATE ALL 3 EDITIONS'}</button>

          {regenResult && (
            <pre style={{
              marginTop: '16px', padding: '14px', background: '#0F0F0F',
              border: '1px solid #2A2A2A', color: '#C0B9AF',
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap',
            }}>{regenResult}</pre>
          )}
        </div>
      </div>
    </>
  )
}

function CenteredMsg({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#1A1A1A', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px',
    }}>
      {children}
    </div>
  )
}
