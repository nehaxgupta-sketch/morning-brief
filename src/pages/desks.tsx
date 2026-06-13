// src/pages/desks.tsx
//
// Sprint 14 — the Desks tab. The app becomes N newspapers in one: the daily
// brief is the front page, a Desk is a full newspaper section.
//
// Layout: subscribed desk cards on top (showing today's edition state —
// tappable through to /desk/[slug] when ready/thin), the full catalog with
// subscribe toggles below. Subscriptions write straight to
// desk_subscriptions under RLS — no API hop (same pattern as
// storyline_follows).
//
// Nav (Sprint 14, locked order): Brief · Stories · Desks · Profile.

import { useEffect, useState } from 'react'
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

type Desk = {
  slug: string
  name: string
  emoji: string
  description: string
  sort_order: number
}

type EditionMeta = {
  desk_slug: string
  status: 'ready' | 'thin' | 'failed'
  date: string
}

function editionStateLabel(meta: EditionMeta | undefined): { label: string; color: string; readable: boolean } {
  if (!meta) return { label: 'PREPARING — READY BY 7:00 AM', color: C.textMute, readable: false }
  if (meta.status === 'ready') return { label: "TODAY'S EDITION READY", color: C.ok, readable: true }
  if (meta.status === 'thin') return { label: "TODAY'S EDITION READY · LIGHT DAY", color: C.warn, readable: true }
  return { label: 'TODAY\'S EDITION FAILED — RETRYING', color: C.err, readable: false }
}

export default function DesksPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [desks, setDesks] = useState<Desk[]>([])
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set())
  const [editions, setEditions] = useState<Map<string, EditionMeta>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)

  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUserId(user.id)

      const [{ data: deskRows }, { data: subRows }, { data: edRows }] = await Promise.all([
        supabase.from('desks')
          .select('slug, name, emoji, description, sort_order')
          .eq('status', 'active')
          .order('sort_order', { ascending: true }),
        supabase.from('desk_subscriptions')
          .select('desk_slug')
          .eq('user_id', user.id),
        supabase.from('desk_editions')
          .select('desk_slug, status, date')
          .eq('date', todayISO),
      ])

      setDesks((deskRows || []) as Desk[])
      setSubscribed(new Set(((subRows || []) as any[]).map(r => r.desk_slug)))
      const edMap = new Map<string, EditionMeta>()
      for (const e of (edRows || []) as EditionMeta[]) edMap.set(e.desk_slug, e)
      setEditions(edMap)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const subscribe = async (desk: Desk) => {
    if (!userId || busy) return
    setBusy(desk.slug)
    const { error } = await supabase
      .from('desk_subscriptions')
      .insert({ user_id: userId, desk_slug: desk.slug })
    setBusy(null)
    if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
      alert('Could not subscribe: ' + error.message)
      return
    }
    setSubscribed(prev => new Set(prev).add(desk.slug))
  }

  const unsubscribe = async (desk: Desk) => {
    if (!userId || busy) return
    setBusy(desk.slug)
    const { error } = await supabase
      .from('desk_subscriptions').delete()
      .eq('user_id', userId).eq('desk_slug', desk.slug)
    setBusy(null)
    if (error) { alert('Could not unsubscribe: ' + error.message); return }
    setSubscribed(prev => { const next = new Set(prev); next.delete(desk.slug); return next })
  }

  const subscribedDesks = desks.filter(d => subscribed.has(d.slug))
  const catalogDesks = desks.filter(d => !subscribed.has(d.slug))

  return (
    <>
      <Head>
        <title>Desks — Morning Brief</title>
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
            Your newspaper, your sections
          </p>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif", fontSize: '36px',
            fontWeight: 900, color: C.text, margin: 0, lineHeight: 1.15,
          }}>
            Desks
          </h1>
          {!loading && subscribedDesks.length > 0 && (
            <p style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textSoft, marginTop: '12px', marginBottom: 0,
            }}>
              {subscribedDesks.length} {subscribedDesks.length === 1 ? 'desk' : 'desks'} · a full daily edition each, ready by 7:00 AM
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

          {/* ─── Subscribed desks ─────────────────────────────────────── */}
          {!loading && subscribedDesks.length > 0 && (
            <div style={{ marginBottom: '44px' }}>
              <p style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: C.gold, letterSpacing: '2.5px',
                textTransform: 'uppercase', margin: '0 0 16px',
              }}>
                Your desks
              </p>
              {subscribedDesks.map(desk => {
                const meta = editions.get(desk.slug)
                const state = editionStateLabel(meta)
                const card = (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    borderTop: `3px solid ${state.readable ? C.gold : C.border}`,
                    padding: '22px',
                    marginBottom: '14px',
                    cursor: state.readable ? 'pointer' : 'default',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontFamily: "'Playfair Display', Georgia, serif",
                          fontSize: '22px', fontWeight: 700, color: C.text,
                          lineHeight: 1.3, marginBottom: '8px',
                        }}>{desk.emoji} {desk.name}</div>
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '10px',
                          letterSpacing: '1.5px', color: state.color,
                        }}>{state.label}</div>
                      </div>
                      {state.readable && (
                        <span style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '16px',
                          color: C.gold, marginTop: '6px',
                        }}>→</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); unsubscribe(desk) }}
                        disabled={busy === desk.slug}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                          color: busy === desk.slug ? C.textDim : C.textMute,
                          padding: '6px 0', minHeight: '44px',
                        }}>
                        {busy === desk.slug ? 'Working…' : 'Unsubscribe'}
                      </button>
                    </div>
                  </div>
                )
                return state.readable ? (
                  <Link key={desk.slug} href={`/desk/${desk.slug}`} style={{ textDecoration: 'none', display: 'block' }}>
                    {card}
                  </Link>
                ) : (
                  <div key={desk.slug}>{card}</div>
                )
              })}
            </div>
          )}

          {/* ─── Empty state (no subscriptions) ───────────────────────── */}
          {!loading && subscribedDesks.length === 0 && (
            <div style={{ textAlign: 'center', paddingTop: '12px', paddingBottom: '36px' }}>
              <div style={{ fontSize: '54px', marginBottom: '20px', color: C.gold }}>▦</div>
              <p style={{
                fontFamily: "'Playfair Display', Georgia, serif", fontSize: '22px',
                color: C.text, marginBottom: '12px', lineHeight: 1.3,
              }}>
                Subscribe to your first desk
              </p>
              <p style={{
                fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                color: C.textSoft, marginBottom: '8px', lineHeight: 1.6,
              }}>
                A desk is a full newspaper section — around 20 detailed
                stories plus a desk editorial, every morning, in a voice
                built for that beat.
              </p>
            </div>
          )}

          {/* ─── Catalog ──────────────────────────────────────────────── */}
          {!loading && catalogDesks.length > 0 && (
            <div style={{ marginBottom: '44px' }}>
              <p style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: C.textMute, letterSpacing: '2.5px',
                textTransform: 'uppercase', margin: '0 0 16px',
              }}>
                {subscribedDesks.length > 0 ? 'More desks' : 'All desks'}
              </p>
              {catalogDesks.map(desk => (
                <div key={desk.slug} style={{
                  background: C.surface2,
                  border: `1px solid ${C.border}`,
                  padding: '20px',
                  marginBottom: '12px',
                }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '19px', fontWeight: 700, color: C.text,
                    lineHeight: 1.3, marginBottom: '8px',
                  }}>{desk.emoji} {desk.name}</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                    color: C.textSoft, lineHeight: 1.6, marginBottom: '16px',
                  }}>{desk.description}</div>
                  <button onClick={() => subscribe(desk)} disabled={busy === desk.slug} style={{
                    background: C.gold, color: '#1A1A1A', border: 'none',
                    borderRadius: '2px', padding: '10px 18px', cursor: 'pointer',
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    fontWeight: 700, letterSpacing: '1.5px', minHeight: '40px',
                  }}>
                    {busy === desk.slug ? 'SUBSCRIBING…' : 'SUBSCRIBE'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bottom nav — Sprint 14: 4 tabs */}
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
