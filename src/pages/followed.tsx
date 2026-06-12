// src/pages/followed.tsx
//
// Sprint 13 — Follow a Story. Replaces the bookmarks page entirely.
//
// Shows, per followed storyline: title + status chip, the living "story so
// far" paragraph, and a reverse-chron timeline of dated events (latest 3 by
// default, expandable). When the user follows nothing — or in addition, when
// high-confidence storylines exist that they don't follow — a "suggested"
// strip nudges them (detection-driven nudge, per the locked design).
//
// All reads/writes here go straight through supabase under RLS — no API
// calls. story_so_far can briefly be empty right after a user-initiated
// follow (the backfill is async); the card shows a gentle placeholder.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)', goldBorder: 'rgba(200,164,90,0.40)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
  ok: '#5FB87E', err: '#E76161',
}

type Storyline = {
  id: string
  slug: string
  title: string
  story_so_far: string | null
  confidence: string
  status: string
  last_event_at: string | null
}

type StoryEvent = {
  id: string
  storyline_id: string
  date: string
  headline: string
  summary: string | null
  source: string | null
  source_url: string | null
  origin: string
}

function statusChip(status: string): { label: string; color: string } {
  if (status === 'active') return { label: 'LIVE', color: C.gold }
  if (status === 'dormant') return { label: 'QUIET', color: C.textMute }
  return { label: 'CONCLUDED', color: C.textDim }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default function FollowedPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [followed, setFollowed] = useState<Storyline[]>([])
  const [suggestions, setSuggestions] = useState<Storyline[]>([])
  const [eventsByLine, setEventsByLine] = useState<Map<string, StoryEvent[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUserId(user.id)

      const { data: followRows } = await supabase
        .from('storyline_follows')
        .select('storyline_id, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      const followedIds = (followRows || []).map((r: any) => r.storyline_id)

      const queries: any[] = [
        // Suggested: high-confidence active storylines (we filter out followed below).
        supabase.from('storylines')
          .select('id, slug, title, story_so_far, confidence, status, last_event_at')
          .eq('status', 'active').eq('confidence', 'high')
          .order('last_event_at', { ascending: false })
          .limit(8),
      ]
      if (followedIds.length > 0) {
        queries.push(
          supabase.from('storylines')
            .select('id, slug, title, story_so_far, confidence, status, last_event_at')
            .in('id', followedIds),
          supabase.from('storyline_events')
            .select('id, storyline_id, date, headline, summary, source, source_url, origin')
            .in('storyline_id', followedIds)
            .order('date', { ascending: false })
            .limit(300),
        )
      }

      const resultsArr = await Promise.all(queries)
      const suggRows = (resultsArr[0]?.data || []) as Storyline[]
      const lineRows = followedIds.length > 0 ? ((resultsArr[1]?.data || []) as Storyline[]) : []
      const evRows = followedIds.length > 0 ? ((resultsArr[2]?.data || []) as StoryEvent[]) : []

      // Preserve follow order (most recently followed first).
      const order = new Map<string, number>()
      followedIds.forEach((id: string, i: number) => order.set(id, i))
      lineRows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
      setFollowed(lineRows)

      const followedSet = new Set(followedIds)
      setSuggestions(suggRows.filter(s => !followedSet.has(s.id)).slice(0, 4))

      const evMap = new Map<string, StoryEvent[]>()
      for (const e of evRows) {
        const arr = evMap.get(e.storyline_id) || []
        arr.push(e)
        evMap.set(e.storyline_id, arr)
      }
      setEventsByLine(evMap)
      setLoading(false)
    }
    load()
  }, [])

  const followSuggestion = async (line: Storyline) => {
    if (!userId || busy) return
    setBusy(line.id)
    const { error } = await supabase
      .from('storyline_follows')
      .insert({ user_id: userId, storyline_id: line.id })
    setBusy(null)
    if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
      alert('Could not follow: ' + error.message)
      return
    }
    setSuggestions(prev => prev.filter(s => s.id !== line.id))
    setFollowed(prev => [line, ...prev])
    // Lazy-load its events.
    const { data: ev } = await supabase
      .from('storyline_events')
      .select('id, storyline_id, date, headline, summary, source, source_url, origin')
      .eq('storyline_id', line.id)
      .order('date', { ascending: false })
      .limit(40)
    if (ev) {
      setEventsByLine(prev => {
        const next = new Map(prev)
        next.set(line.id, ev as StoryEvent[])
        return next
      })
    }
  }

  const unfollow = async (line: Storyline) => {
    if (!userId || busy) return
    setBusy(line.id)
    const { error } = await supabase
      .from('storyline_follows').delete()
      .eq('user_id', userId).eq('storyline_id', line.id)
    setBusy(null)
    if (error) { alert('Could not unfollow: ' + error.message); return }
    setFollowed(prev => prev.filter(s => s.id !== line.id))
  }

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <>
      <Head>
        <title>Followed Stories — Morning Brief</title>
      </Head>

      <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: '88px' }}>
        {/* Header */}
        <div style={{
          padding: '52px 24px 28px',
          borderBottom: `2px solid ${C.gold}`,
          background: C.bg,
        }}>
          <p style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            color: C.gold, letterSpacing: '2.5px',
            textTransform: 'uppercase', margin: '0 0 10px',
          }}>
            The stories you track
          </p>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif", fontSize: '36px',
            fontWeight: 900, color: C.text, margin: 0, lineHeight: 1.15,
          }}>
            Followed Stories
          </h1>
          {!loading && followed.length > 0 && (
            <p style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textSoft, marginTop: '12px', marginBottom: 0,
            }}>
              {followed.length} {followed.length === 1 ? 'storyline' : 'storylines'} · updated every morning
            </p>
          )}
        </div>

        <div style={{ padding: '28px 20px 0', maxWidth: '480px', margin: '0 auto' }}>

          {loading && (
            <div style={{ textAlign: 'center', paddingTop: '80px' }}>
              <div style={{
                width: '32px', height: '32px',
                border: `2px solid ${C.border}`,
                borderTopColor: C.gold, borderRadius: '50%',
                animation: 'spin 0.8s linear infinite', margin: '0 auto',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Suggested strip — detection-driven nudge */}
          {!loading && suggestions.length > 0 && (
            <div style={{ marginBottom: '36px' }}>
              <p style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: C.gold, letterSpacing: '2.5px',
                textTransform: 'uppercase', margin: '0 0 16px',
              }}>
                📌 Developing stories worth following
              </p>
              {suggestions.map(line => (
                <div key={line.id} style={{
                  background: C.goldSoft, border: `1px solid ${C.goldBorder}`,
                  padding: '18px 20px', marginBottom: '12px',
                }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '18px', fontWeight: 700, color: C.text,
                    lineHeight: 1.35, marginBottom: '8px',
                  }}>{line.title}</div>
                  {line.story_so_far && (
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                      color: C.textSoft, lineHeight: 1.6, marginBottom: '14px',
                      display: '-webkit-box', WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>{line.story_so_far}</div>
                  )}
                  <button onClick={() => followSuggestion(line)} disabled={busy === line.id} style={{
                    background: C.gold, color: '#1A1A1A', border: 'none',
                    borderRadius: '2px', padding: '10px 18px', cursor: 'pointer',
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    fontWeight: 700, letterSpacing: '1.5px', minHeight: '40px',
                  }}>
                    {busy === line.id ? 'FOLLOWING…' : 'FOLLOW THIS STORY'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && followed.length === 0 && (
            <div style={{ textAlign: 'center', paddingTop: suggestions.length > 0 ? '20px' : '60px' }}>
              <div style={{ fontSize: '54px', marginBottom: '20px', color: C.gold }}>◉</div>
              <p style={{
                fontFamily: "'Playfair Display', Georgia, serif", fontSize: '22px',
                color: C.text, marginBottom: '12px', lineHeight: 1.3,
              }}>
                Follow your first story
              </p>
              <p style={{
                fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                color: C.textSoft, marginBottom: '36px', lineHeight: 1.6,
              }}>
                Tap FOLLOW on any story in your brief. You'll get the full
                context — how it started, every development since, and each
                morning's update — all in one place.
              </p>
              <Link
                href="/brief"
                style={{
                  background: C.gold, color: '#0E0E0E', border: 'none',
                  borderRadius: '2px', padding: '16px 32px',
                  fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                  fontWeight: 700, letterSpacing: '1.5px',
                  textTransform: 'uppercase', textDecoration: 'none',
                  display: 'inline-block', minHeight: '52px',
                }}
              >
                Read Today's Brief
              </Link>
            </div>
          )}

          {/* Followed storyline cards */}
          {!loading && followed.map(line => {
            const events = eventsByLine.get(line.id) || []
            const isOpen = expanded.has(line.id)
            const shown = isOpen ? events : events.slice(0, 3)
            const chip = statusChip(line.status)
            return (
              <div key={line.id} style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderTop: `3px solid ${line.status === 'active' ? C.gold : C.border}`,
                padding: '22px',
                marginBottom: '20px',
              }}>
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '22px', fontWeight: 700, color: C.text, lineHeight: 1.3,
                  }}>{line.title}</div>
                  <span style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '9px',
                    letterSpacing: '1.5px', color: chip.color,
                    border: `1px solid ${chip.color}`, borderRadius: '2px',
                    padding: '4px 8px', whiteSpace: 'nowrap', marginTop: '4px',
                  }}>{chip.label}</span>
                </div>

                {/* Story so far */}
                <div style={{ marginBottom: '18px' }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '2px', color: C.gold, marginBottom: '8px',
                  }}>THE STORY SO FAR</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                    color: line.story_so_far ? C.textSoft : C.textDim,
                    lineHeight: 1.7, fontStyle: line.story_so_far ? 'normal' : 'italic',
                  }}>
                    {line.story_so_far || 'Pulling together the history of this story — check back in a minute.'}
                  </div>
                </div>

                {/* Timeline */}
                {events.length > 0 && (
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '16px' }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '2px', color: C.textMute, marginBottom: '4px',
                    }}>TIMELINE</div>
                    {shown.map(ev => (
                      <div key={ev.id} style={{
                        padding: '14px 0 14px 18px',
                        borderBottom: `1px solid ${C.border}`,
                        position: 'relative',
                      }}>
                        <span style={{
                          position: 'absolute', left: 0, top: '20px',
                          width: '6px', height: '6px', borderRadius: '50%',
                          background: ev.origin === 'backfill' ? C.textDim : C.gold,
                        }} />
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '10px',
                          letterSpacing: '1.5px', color: C.textMute, marginBottom: '6px',
                        }}>
                          {formatDate(ev.date).toUpperCase()}{ev.origin === 'backfill' ? ' · CONTEXT' : ''}
                        </div>
                        <div style={{
                          fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                          fontWeight: 600, color: C.text, lineHeight: 1.5,
                          marginBottom: ev.summary ? '6px' : 0,
                        }}>{ev.headline}</div>
                        {ev.summary && (
                          <div style={{
                            fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                            color: C.textSoft, lineHeight: 1.6,
                            marginBottom: ev.source ? '8px' : 0,
                          }}>{ev.summary}</div>
                        )}
                        {ev.source && (
                          ev.source_url ? (
                            <a href={ev.source_url} target="_blank" rel="noopener noreferrer" style={{
                              fontFamily: "'DM Mono', monospace", fontSize: '10px',
                              color: C.textMute, textDecoration: 'none', letterSpacing: '1px',
                            }}>via {ev.source} ↗</a>
                          ) : (
                            <span style={{
                              fontFamily: "'DM Mono', monospace", fontSize: '10px',
                              color: C.textDim, letterSpacing: '1px',
                            }}>via {ev.source}</span>
                          )
                        )}
                      </div>
                    ))}
                    {events.length > 3 && (
                      <button onClick={() => toggleExpanded(line.id)} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        letterSpacing: '1.5px', color: C.gold,
                        padding: '14px 0 4px', minHeight: '44px',
                      }}>
                        {isOpen ? '▲ SHOW LESS' : `▼ FULL TIMELINE (${events.length})`}
                      </button>
                    )}
                  </div>
                )}

                {/* Card footer */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                  <button onClick={() => unfollow(line)} disabled={busy === line.id} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                    color: busy === line.id ? C.textDim : C.err,
                    padding: '6px 0', minHeight: '44px',
                  }}>
                    {busy === line.id ? 'Working…' : 'Unfollow'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Bottom nav */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: C.surface, borderTop: `1px solid ${C.border}`,
          display: 'flex', height: '64px',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}>
          {[
            { href: '/home',      label: 'Brief',   icon: '◆', active: false },
            { href: '/followed',  label: 'Stories', icon: '◉', active: true },
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
