// src/pages/desk/[slug].tsx
//
// Sprint 14 — the Desk reader. One desk's daily edition, read like a real
// newspaper section: lens line, Top Stories (full detail), India, Global,
// Features (the 7-day pieces, kind-labelled), Quick Takes, and the Desk
// Editorial — with the brief.tsx-style fixed section rail on the left.
//
// Follow pills: desk stories feed the SAME storyline system as the brief.
// The mapping/follow logic mirrors brief.tsx — stories already mapped to a
// storyline (via source_url ↔ last-7-days storyline_events) toggle follows
// directly under RLS; unmapped stories go through POST /api/storylines
// create-and-follow, then fire-and-forget the backfill.
//
// If today's edition isn't ready yet, the most recent earlier edition is
// shown with a dated banner — a desk subscriber should never hit a dead end.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)', goldBorder: 'rgba(200,164,90,0.40)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
  ok: '#5FB87E', warn: '#E0A85C', err: '#E76161',
}

// ─── Types ──────────────────────────────────────────────────────────────────

type Desk = {
  slug: string
  name: string
  emoji: string
  description: string
}

interface DeskStory {
  headline: string
  facts?: string
  background?: string
  why_it_matters?: string
  body?: string
  kind?: string
  source: string
  source_url?: string
}

interface DeskEditionContent {
  desk: string
  date: string
  lens?: string
  top_stories?: DeskStory[]
  india?: DeskStory[]
  global?: DeskStory[]
  features?: DeskStory[]
  quick_takes?: DeskStory[]
  desk_editorial?: { title: string; body: string }
}

type FollowState = 'none' | 'following' | 'busy' | 'declined'

interface FollowApi {
  stateFor: (story: any) => FollowState
  nudgeFor: (story: any) => boolean
  toggle: (story: any) => void
}

// ─── Section catalogue ──────────────────────────────────────────────────────

interface SectionDef { id: string; label: string; icon: string }

const DESK_SECTIONS: SectionDef[] = [
  { id: 'top_stories', label: 'Top stories', icon: '🔥' },
  { id: 'india',       label: 'India',       icon: '🇮🇳' },
  { id: 'global',      label: 'Global',      icon: '🌍' },
  { id: 'features',    label: 'Features',    icon: '📖' },
  { id: 'quick_takes', label: 'Quick takes', icon: '⚡' },
]

// ─── Shared bits (mirrors brief.tsx) ────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: '30px', fontWeight: 800, color: C.gold,
      marginBottom: '6px', display: 'flex', alignItems: 'center',
      gap: '12px', lineHeight: 1.15,
    }}>{children}</div>
  )
}

function SourceLine({ source, sourceUrl }: { source: string; sourceUrl?: string }) {
  const s: React.CSSProperties = {
    fontFamily: "'DM Mono', monospace", fontSize: '11px',
    letterSpacing: '1.5px', color: C.textMute, textDecoration: 'none',
  }
  if (sourceUrl) {
    return <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={s}>via {source} ↗</a>
  }
  return <div style={s}>via {source}</div>
}

function FollowButton({ state, nudge, onToggle }: {
  state: FollowState; nudge: boolean; onToggle: () => void
}) {
  const isNudge = nudge && state === 'none'
  const label =
    state === 'following' ? 'FOLLOWING ✓'
    : state === 'busy' ? 'FOLLOWING…'
    : state === 'declined' ? 'ONE-OFF STORY'
    : isNudge ? '📌 FOLLOW THIS STORY'
    : 'FOLLOW'
  return (
    <button onClick={onToggle} disabled={state === 'busy' || state === 'declined'} style={{
      background: isNudge ? C.gold : 'none',
      border: isNudge ? 'none' : `1px solid ${state === 'following' ? 'rgba(200,164,90,0.45)' : C.border}`,
      borderRadius: '2px',
      cursor: state === 'busy' || state === 'declined' ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '8px 12px', minHeight: '40px', whiteSpace: 'nowrap',
      fontFamily: "'DM Mono', monospace", fontSize: '10px',
      letterSpacing: '1.5px', fontWeight: isNudge ? 700 : 400,
      color: isNudge ? '#1A1A1A'
        : state === 'following' ? C.gold
        : state === 'declined' ? C.textDim
        : C.textMute,
    }} title={state === 'following' ? 'Unfollow this story' : 'Follow this story for daily updates and full context'}>
      {label}
    </button>
  )
}

// Full-detail card (top_stories / india / global).
function DeskFullCard({ story, follow }: { story: DeskStory; follow: FollowApi }) {
  const fields: [string, string | undefined][] = [
    ['FACTS', story.facts],
    ['BACKGROUND', story.background],
    ['WHY IT MATTERS', story.why_it_matters],
  ]
  return (
    <div style={{ padding: '24px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '23px', fontWeight: 700, color: C.text,
        lineHeight: 1.32, marginBottom: '16px',
      }}>{story.headline}</div>

      <div style={{ marginBottom: '16px' }}>
        {fields.map(([label, val]) => val ? (
          <div key={label} style={{ marginBottom: '14px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.gold, marginBottom: '6px',
            }}>{label}</div>
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '17px',
              color: C.textSoft, lineHeight: 1.75,
            }}>{val}</div>
          </div>
        ) : null)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SourceLine source={story.source} sourceUrl={story.source_url} />
        <FollowButton state={follow.stateFor(story)} nudge={follow.nudgeFor(story)} onToggle={() => follow.toggle(story)} />
      </div>
    </div>
  )
}

// Feature card — body + kind chip.
function DeskFeatureCard({ story, follow }: { story: DeskStory; follow: FollowApi }) {
  return (
    <div style={{ padding: '22px 0', borderBottom: `1px solid ${C.border}` }}>
      {story.kind && (
        <span style={{
          display: 'inline-block',
          fontFamily: "'DM Mono', monospace", fontSize: '9px',
          letterSpacing: '1.5px', color: C.gold,
          border: `1px solid ${C.goldBorder}`, borderRadius: '2px',
          padding: '4px 8px', marginBottom: '12px',
        }}>{String(story.kind).toUpperCase()}</span>
      )}
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '21px', fontWeight: 700, color: C.text,
        lineHeight: 1.35, marginBottom: '10px',
      }}>{story.headline}</div>
      {story.body && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
          color: C.textSoft, lineHeight: 1.7, marginBottom: '14px',
        }}>{story.body}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SourceLine source={story.source} sourceUrl={story.source_url} />
        <FollowButton state={follow.stateFor(story)} nudge={follow.nudgeFor(story)} onToggle={() => follow.toggle(story)} />
      </div>
    </div>
  )
}

// Quick take — compact micro item.
function DeskQuickCard({ story, follow }: { story: DeskStory; follow: FollowApi }) {
  return (
    <div style={{ padding: '18px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '18px', fontWeight: 700, color: C.text,
        lineHeight: 1.35, marginBottom: '8px',
      }}>{story.headline}</div>
      {story.body && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
          color: C.textSoft, lineHeight: 1.65, marginBottom: '12px',
        }}>{story.body}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SourceLine source={story.source} sourceUrl={story.source_url} />
        <FollowButton state={follow.stateFor(story)} nudge={follow.nudgeFor(story)} onToggle={() => follow.toggle(story)} />
      </div>
    </div>
  )
}

function SidebarNav({ sections, activeSection }: {
  sections: SectionDef[]; activeSection: string
}) {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div style={{
      position: 'fixed', left: 0, top: '50%',
      transform: 'translateY(-50%)', zIndex: 20,
      display: 'flex', flexDirection: 'column', gap: '2px',
      padding: '8px 0', background: C.surface,
      borderRight: `1px solid ${C.border}`,
      maxHeight: '90vh', overflowY: 'auto',
    }}>
      {sections.map(({ id, label, icon }) => {
        const isActive = activeSection === id
        return (
          <button key={id} onClick={() => scrollTo(id)} style={{
            background: 'none', border: 'none',
            borderLeft: isActive ? `2px solid ${C.gold}` : '2px solid transparent',
            padding: '10px', cursor: 'pointer',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: '4px', width: '56px',
          }}>
            <span style={{ fontSize: '16px', lineHeight: 1 }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '8px',
              letterSpacing: '0.6px',
              color: isActive ? C.gold : C.textMute,
              lineHeight: 1, textAlign: 'center',
            }}>{label.toUpperCase()}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function DeskReaderPage() {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : ''

  const [loading, setLoading] = useState(true)
  const [desk, setDesk] = useState<Desk | null>(null)
  const [edition, setEdition] = useState<DeskEditionContent | null>(null)
  const [editionDate, setEditionDate] = useState<string>('')
  const [editionStatus, setEditionStatus] = useState<string>('')
  const [userId, setUserId] = useState<string | null>(null)

  // Follow a Story state — mirrors brief.tsx.
  const [storylineByUrl, setStorylineByUrl] = useState<Map<string, { id: string; title: string; confidence: string }>>(new Map())
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set())
  const [busyUrls, setBusyUrls] = useState<Set<string>>(new Set())
  const [declinedUrls, setDeclinedUrls] = useState<Set<string>>(new Set())
  const [accessToken, setAccessToken] = useState<string>('')

  const [activeSection, setActiveSection] = useState<string>('top_stories')

  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    if (!router.isReady || !slug) return
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUserId(user.id)
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) setAccessToken(session.access_token)

      // Desk + most recent readable edition (today first, else latest).
      const [{ data: deskRow }, { data: edRows }] = await Promise.all([
        supabase.from('desks')
          .select('slug, name, emoji, description')
          .eq('slug', slug)
          .maybeSingle(),
        supabase.from('desk_editions')
          .select('date, content, status')
          .eq('desk_slug', slug)
          .in('status', ['ready', 'thin'])
          .order('date', { ascending: false })
          .limit(1),
      ])

      if (!deskRow) { setLoading(false); return }
      setDesk(deskRow as Desk)

      const ed = edRows?.[0] as any
      if (ed?.content) {
        setEdition(ed.content as DeskEditionContent)
        setEditionDate(ed.date)
        setEditionStatus(ed.status)
      }

      // Storyline mapping + follows (same window as brief.tsx).
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const [{ data: lineRows }, { data: evRows }, { data: followRows }] = await Promise.all([
        supabase.from('storylines').select('id, title, confidence, status').in('status', ['active', 'dormant']),
        supabase.from('storyline_events').select('storyline_id, source_url').gte('date', sevenDaysAgo),
        supabase.from('storyline_follows').select('storyline_id').eq('user_id', user.id),
      ])
      const lineById = new Map<string, { id: string; title: string; confidence: string }>()
      for (const l of (lineRows || []) as any[]) lineById.set(l.id, { id: l.id, title: l.title, confidence: l.confidence })
      const urlMap = new Map<string, { id: string; title: string; confidence: string }>()
      for (const e of (evRows || []) as any[]) {
        if (e.source_url && lineById.has(e.storyline_id)) urlMap.set(e.source_url, lineById.get(e.storyline_id)!)
      }
      setStorylineByUrl(urlMap)
      setFollowedIds(new Set(((followRows || []) as any[]).map(f => f.storyline_id)))

      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, slug])

  // Section rail scroll-spy.
  const visibleSections = DESK_SECTIONS.filter(s =>
    Array.isArray((edition as any)?.[s.id]) && ((edition as any)[s.id] as any[]).length > 0
  )
  const navSections: SectionDef[] = [...visibleSections]
  if (edition?.desk_editorial?.body) {
    navSections.push({ id: 'desk_editorial', label: 'Editorial', icon: '🖋️' })
  }

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...navSections].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 140) { setActiveSection(id); return }
      }
      if (navSections[0]) setActiveSection(navSections[0].id)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition])

  // ─── Follow / unfollow — identical contract to brief.tsx ─────────────────
  const toggleFollow = async (story: any) => {
    if (!userId) {
      alert('Your session was not found — please log in again.')
      return
    }
    const url = story?.source_url || ''
    const line = url ? storylineByUrl.get(url) : undefined

    if (line) {
      const isFollowing = followedIds.has(line.id)
      setFollowedIds(prev => {
        const next = new Set(prev)
        if (isFollowing) next.delete(line.id); else next.add(line.id)
        return next
      })
      if (isFollowing) {
        const { error } = await supabase
          .from('storyline_follows').delete()
          .eq('user_id', userId).eq('storyline_id', line.id)
        if (error) {
          setFollowedIds(prev => new Set(prev).add(line.id))
          alert('Could not unfollow: ' + error.message)
        }
      } else {
        const { error } = await supabase
          .from('storyline_follows')
          .insert({ user_id: userId, storyline_id: line.id })
        if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
          setFollowedIds(prev => { const next = new Set(prev); next.delete(line.id); return next })
          alert('Could not follow: ' + error.message)
        }
      }
      return
    }

    // No storyline yet — qualify + create via the API, then fire-and-forget
    // the historical backfill (the morning pipeline self-heals stragglers).
    if (!url || busyUrls.has(url)) return
    setBusyUrls(prev => new Set(prev).add(url))
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      const resp = await fetch('/api/storylines', {
        method: 'POST', headers,
        body: JSON.stringify({
          action: 'create-and-follow',
          story: {
            headline: story?.headline || '',
            summary: story?.facts || story?.body || '',
            source: story?.source || '',
            source_url: url,
          },
        }),
      })
      const data = await resp.json()
      if (data?.ok && data?.qualified && data?.storyline?.id) {
        const newLine = { id: data.storyline.id, title: data.storyline.title, confidence: data.storyline.confidence || 'normal' }
        setStorylineByUrl(prev => { const next = new Map(prev); next.set(url, newLine); return next })
        setFollowedIds(prev => new Set(prev).add(newLine.id))
        void fetch('/api/storylines', {
          method: 'POST', headers,
          body: JSON.stringify({ action: 'backfill', storylineId: newLine.id }),
        }).catch(() => {})
      } else if (data?.ok && data?.qualified === false) {
        setDeclinedUrls(prev => new Set(prev).add(url))
        setTimeout(() => {
          setDeclinedUrls(prev => { const next = new Set(prev); next.delete(url); return next })
        }, 4000)
      } else {
        alert('Could not follow this story: ' + (data?.error || 'unknown error'))
      }
    } catch (e: any) {
      alert('Could not follow this story: ' + (e?.message || e))
    } finally {
      setBusyUrls(prev => { const next = new Set(prev); next.delete(url); return next })
    }
  }

  const followApi: FollowApi = {
    stateFor: (story: any) => {
      const url = story?.source_url || ''
      if (url && busyUrls.has(url)) return 'busy'
      if (url && declinedUrls.has(url)) return 'declined'
      const line = url ? storylineByUrl.get(url) : undefined
      if (line && followedIds.has(line.id)) return 'following'
      return 'none'
    },
    nudgeFor: (story: any) => {
      const url = story?.source_url || ''
      const line = url ? storylineByUrl.get(url) : undefined
      return !!line && line.confidence === 'high' && !followedIds.has(line.id)
    },
    toggle: toggleFollow,
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const editionDisplay = editionDate
    ? new Date(editionDate).toLocaleDateString('en-IN', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })
    : ''
  const isStale = !!editionDate && editionDate !== todayISO

  return (
    <>
      <Head>
        <title>{desk ? `${desk.name} — Morning Brief` : 'Desk — Morning Brief'}</title>
      </Head>

      <div style={{ minHeight: '100vh', background: C.bg }}>
        {/* Header */}
        <div style={{
          background: C.bg, borderBottom: `2px solid ${C.gold}`,
          padding: '22px 20px 18px', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Link href="/desks" style={{
              color: C.textMute, textDecoration: 'none', fontSize: '22px',
              marginRight: '18px', minHeight: '44px',
              display: 'flex', alignItems: 'center',
            }}>←</Link>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.gold, marginBottom: '4px',
              }}>DESK</div>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: '26px', fontWeight: 900, color: C.text, lineHeight: 1.1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{desk ? `${desk.emoji} ${desk.name}` : 'Desk'}</div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: C.textMute, lineHeight: 1.7,
              }}>{editionDisplay ? editionDisplay.toUpperCase() : ''}</div>
              {editionStatus === 'thin' && (
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '1.5px', color: C.warn,
                }}>LIGHT DAY</div>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ paddingBottom: '88px' }}>
          {loading ? (
            <div style={{ padding: '80px 20px', textAlign: 'center' }}>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: '22px', fontStyle: 'italic', color: C.textMute,
              }}>Fetching the {desk?.name || 'desk'} edition…</div>
            </div>
          ) : !desk ? (
            <div style={{ padding: '60px 20px', textAlign: 'center' }}>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: '22px', color: C.text, marginBottom: '12px',
              }}>This desk doesn't exist.</div>
              <Link href="/desks" style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                letterSpacing: '1.5px', color: C.gold, textDecoration: 'none',
              }}>← BACK TO DESKS</Link>
            </div>
          ) : !edition ? (
            <div style={{ padding: '32px 20px' }}>
              <div style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderTop: `3px solid ${C.gold}`, padding: '28px 24px',
              }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '11px',
                  letterSpacing: '2px', color: C.gold, marginBottom: '18px',
                }}>THIS DESK'S FIRST EDITION IS BEING PREPARED</div>
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif", fontSize: '24px',
                  fontStyle: 'italic', color: C.text, marginBottom: '16px', lineHeight: 1.4,
                }}>Ready tomorrow by 7:00 AM.</div>
                <div style={{
                  fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                  color: C.textSoft, lineHeight: 1.7,
                }}>
                  Every morning, the {desk.name} desk assembles around 20
                  detailed stories — top stories, India, global, features, and
                  quick takes — plus a desk editorial, written for readers who
                  follow this beat.
                </div>
              </div>
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <SidebarNav sections={navSections} activeSection={activeSection} />
              <div style={{ padding: '0 20px 40px 72px' }}>

                {/* Stale banner */}
                {isStale && (
                  <div style={{
                    background: C.surface2, border: `1px solid ${C.border}`,
                    borderLeft: `3px solid ${C.warn}`,
                    padding: '14px 18px', marginTop: '20px',
                  }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px', color: C.warn, marginBottom: '6px',
                    }}>SHOWING THE LATEST AVAILABLE EDITION</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                      color: C.textSoft, lineHeight: 1.6,
                    }}>Today's edition is still being prepared — this is {editionDisplay}'s.</div>
                  </div>
                )}

                {/* Lens */}
                {edition.lens && (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    borderTop: `3px solid ${C.gold}`,
                    padding: '22px', marginTop: '20px',
                  }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '2px', color: C.gold, marginBottom: '12px',
                    }}>TODAY ON THIS DESK</div>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '20px', fontWeight: 700, color: C.text,
                      lineHeight: 1.4,
                    }}>{edition.lens}</div>
                  </div>
                )}

                {/* Sections */}
                {visibleSections.map((section, idx) => {
                  const stories = ((edition as any)[section.id] || []) as DeskStory[]
                  return (
                    <div key={section.id} id={section.id} style={{ paddingTop: idx === 0 ? '36px' : '44px' }}>
                      <SectionLabel>{section.icon} {section.label}</SectionLabel>
                      {section.id === 'features'
                        ? stories.map((story, i) => <DeskFeatureCard key={i} story={story} follow={followApi} />)
                        : section.id === 'quick_takes'
                          ? stories.map((story, i) => <DeskQuickCard key={i} story={story} follow={followApi} />)
                          : stories.map((story, i) => <DeskFullCard key={i} story={story} follow={followApi} />)
                      }
                    </div>
                  )
                })}

                {/* Desk editorial */}
                {edition.desk_editorial?.body && (
                  <div id="desk_editorial" style={{ paddingTop: '64px', marginTop: '28px', borderTop: `1px solid ${C.border}` }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '2px', color: C.gold, marginBottom: '10px',
                    }}>FROM THE {desk.name.toUpperCase()} DESK</div>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '28px', fontWeight: 800, color: C.text,
                      lineHeight: 1.25, marginBottom: '20px',
                    }}>{edition.desk_editorial.title}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '17px',
                      color: C.textSoft, lineHeight: 1.85, whiteSpace: 'pre-wrap',
                    }}>{edition.desk_editorial.body}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom nav — Sprint 14: 4 tabs, Desks active (reader lives under it) */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: C.surface, borderTop: `1px solid ${C.border}`,
          display: 'flex', height: '64px',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}>
          {[
            { href: '/home',      label: 'Brief',   icon: '◆', active: false },
            { href: '/followed',  label: 'Stories', icon: '◉', active: false },
            { href: '/desks',     label: 'Desks',   icon: '▦', active: true  },
            { href: '/profile',   label: 'Profile', icon: '◑', active: false },
          ].map(({ href, label, icon, active }) => (
            <Link key={href} href={href} style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: '4px', textDecoration: 'none', minHeight: '60px',
            }}>
              <span style={{ fontSize: '18px', color: active ? C.gold : C.textMute }}>{icon}</span>
              <span style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: active ? C.gold : C.textMute,
              }}>{label.toUpperCase()}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
