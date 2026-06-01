// src/pages/home.tsx
//
// Sprint 8 — home screen with the lens flash card and three edition buttons.
// The card shows the day's shape at a glance: world / India / markets / watch.
// Below it, three buttons take the reader straight into The Brief / The Daily
// / The Editorial.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)', goldBorder: 'rgba(200,164,90,0.40)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
}

interface Lens {
  world?: string
  india?: string
  markets?: string
  watch?: string
}

function normaliseEdition(raw: string | undefined | null): '5min' | '10min' | 'deep' {
  const p = raw === 'ultra' ? '5min' : raw
  if (p === '5min' || p === '10min' || p === 'deep') return p
  return '10min'
}

function editionDisplay(e: string) {
  if (e === '5min') return 'The Brief'
  if (e === '10min') return 'The Daily'
  if (e === 'deep') return 'The Editorial'
  return e
}

function editionTagline(e: string) {
  if (e === '5min') return '5 min · skim the day'
  if (e === '10min') return '10 min · full read'
  if (e === 'deep') return '15 min · synthesis'
  return ''
}

export default function Home() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [briefReady, setBriefReady] = useState(false)
  const [lens, setLens] = useState<Lens | null>(null)
  const [availableEditions, setAvailableEditions] = useState<Set<string>>(new Set())

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }

      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data && !data.onboarding_complete) { window.location.href = '/onboarding'; return }
      setProfile(data)

      const isPersonalised = data?.brief_type === 'personalised'

      // 1. Try personalised briefs first (for personalised users)
      let editionsFound = new Set<string>()
      let lensFound: Lens | null = null

      if (isPersonalised) {
        const { data: personalised } = await supabase
          .from('personalised_briefs')
          .select('edition, content')
          .eq('user_id', user.id)
          .eq('date', todayISO)
          .in('status', ['ready', 'fallback'])
        if (personalised && personalised.length > 0) {
          for (const row of personalised as any[]) {
            editionsFound.add(row.edition)
            if (!lensFound && row.content?.lens) lensFound = row.content.lens
          }
        }
      }

      // 2. Fallback to standard briefs
      if (editionsFound.size === 0) {
        const { data: standard } = await supabase
          .from('briefs')
          .select('edition, content')
          .eq('date', todayISO)
          .in('status', ['ready', 'fallback'])
        if (standard && standard.length > 0) {
          for (const row of standard as any[]) {
            editionsFound.add(row.edition)
            if (!lensFound && row.content?.lens) lensFound = row.content.lens
          }
        }
      }

      setAvailableEditions(editionsFound)
      setLens(lensFound)
      setBriefReady(editionsFound.size > 0)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return null

  const firstName = profile?.full_name?.split(' ')[0] || 'Reader'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const isPersonalised = profile?.brief_type === 'personalised'
  const defaultEdition = normaliseEdition(profile?.edition_preference as string)

  // For the "preparing" preview, show what their personalised brief WILL cover
  const previewLines: string[] = isPersonalised
    ? [
        `📍 ${profile?.city_current || 'Your city'} local news`,
        '🔥 Major events worth tracking',
        '🌍 World affairs & India politics',
        profile?.interests?.length
          ? `🎯 ${profile.interests.slice(0, 3).join(', ')}`
          : '🎯 Your interests',
        `📖 ${editionDisplay(defaultEdition)} as your default`,
      ]
    : [
        '🔥 Major events worth tracking',
        '🌍 World affairs & India politics',
        '📈 Markets, business, technology',
        '🏏 Sport & culture highlights',
        '📖 Three editions to choose from',
      ]

  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: '88px' }}>
      {/* Header */}
      <div style={{
        background: C.bg, borderBottom: `2px solid ${C.gold}`,
        padding: '0 20px', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between',
        height: '56px', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px', fontWeight: 900, color: C.gold,
          letterSpacing: '0.2px',
        }}>Morning Brief</div>
        <Link href="/profile" style={{
          fontFamily: "'DM Mono', monospace", fontSize: '10px',
          letterSpacing: '1.5px', color: C.textMute,
          textDecoration: 'none', minHeight: '44px',
          display: 'flex', alignItems: 'center',
        }}>PROFILE</Link>
      </div>

      {/* Greeting */}
      <div style={{ background: C.bg, padding: '20px 20px 24px' }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '10px',
          letterSpacing: '2px', color: C.textMute, marginBottom: '6px',
        }}>{today.toUpperCase()}</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '24px', fontWeight: 700, color: C.text, lineHeight: 1.3,
        }}>{greeting}, {firstName}.</div>
      </div>

      <div style={{ padding: '0 20px', maxWidth: '480px', margin: '0 auto' }}>

        {briefReady ? (
          <>
            {/* Flash card — lens table */}
            <div style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderTop: `3px solid ${C.gold}`,
              padding: '22px',
              marginBottom: '20px',
            }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.gold, marginBottom: '18px',
              }}>TODAY'S LENS</div>

              {lens ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {[
                    { label: 'World', value: lens.world },
                    { label: 'India', value: lens.india },
                    { label: 'Markets', value: lens.markets },
                    { label: 'Watch', value: lens.watch },
                  ].map((row, i, arr) =>
                    row.value ? (
                      <div key={row.label} style={{
                        paddingBottom: i < arr.length - 1 ? '14px' : 0,
                        borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : 'none',
                      }}>
                        <div style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '10px',
                          letterSpacing: '1.5px', color: C.gold, marginBottom: '6px',
                        }}>{row.label.toUpperCase()}</div>
                        <div style={{
                          fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                          color: C.textSoft, lineHeight: 1.55,
                        }}>{row.value}</div>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : (
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '20px', fontWeight: 700, color: C.text,
                  lineHeight: 1.35, marginBottom: '4px',
                }}>Your brief is ready.</div>
              )}
            </div>

            {/* Edition picker */}
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '2px', color: C.textMute, marginBottom: '12px',
            }}>CHOOSE YOUR READ</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              {(['5min', '10min', 'deep'] as const).map((ed) => {
                const isAvailable = availableEditions.has(ed)
                const isDefault = ed === defaultEdition
                return (
                  <Link
                    key={ed}
                    href={isAvailable ? `/brief?edition=${ed}` : '#'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '18px 20px',
                      background: isDefault ? C.gold : (isAvailable ? C.surface : C.surface2),
                      color: isDefault ? '#0E0E0E' : (isAvailable ? C.text : C.textDim),
                      border: `1px solid ${isDefault ? C.gold : C.border}`,
                      textDecoration: 'none',
                      pointerEvents: isAvailable ? 'auto' : 'none',
                      opacity: isAvailable ? 1 : 0.55,
                      minHeight: '64px',
                    }}
                  >
                    <div>
                      <div style={{
                        fontFamily: "'Playfair Display', Georgia, serif",
                        fontSize: '18px', fontWeight: 700,
                        marginBottom: '2px',
                        color: isDefault ? '#0E0E0E' : (isAvailable ? C.text : C.textDim),
                      }}>{editionDisplay(ed)}</div>
                      <div style={{
                        fontFamily: "'DM Mono', monospace", fontSize: '10px',
                        letterSpacing: '1.5px',
                        color: isDefault ? '#0E0E0E' : C.textMute,
                      }}>{editionTagline(ed).toUpperCase()}</div>
                    </div>
                    <span style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '14px',
                      color: isDefault ? '#0E0E0E' : (isAvailable ? C.gold : C.textDim),
                    }}>{isAvailable ? '→' : '—'}</span>
                  </Link>
                )
              })}
            </div>

            {isPersonalised && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: C.textMute,
                textAlign: 'center', marginBottom: '12px',
              }}>YOUR BRIEF IS PERSONALISED FOR YOU</div>
            )}
          </>
        ) : (
          /* Not ready yet — show the preview card */
          <div style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderTop: `3px solid ${C.gold}`,
            padding: '22px',
            marginBottom: '20px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '2px', color: C.gold, marginBottom: '12px',
            }}>YOUR BRIEF IS BEING PREPARED</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif", fontSize: '20px',
              fontWeight: 700, color: C.text, marginBottom: '12px', lineHeight: 1.35,
            }}>Tomorrow at 6:45 AM IST.</div>
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textSoft, lineHeight: 1.65, marginBottom: '22px',
            }}>
              {isPersonalised
                ? `Your personalised brief — tailored to ${profile?.city_current || 'your city'} and your interests — will be ready every morning.`
                : 'Your standard brief covering the day\'s biggest stories will be ready every morning.'
              }
            </div>
            <div style={{
              background: C.surface2, border: `1px solid ${C.border}`,
              padding: '16px', marginBottom: '20px',
            }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '2px', color: C.gold, marginBottom: '10px',
              }}>YOUR BRIEF WILL COVER</div>
              {previewLines.map((item, i) => (
                <div key={i} style={{
                  fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                  color: C.textSoft, padding: '8px 0',
                  borderBottom: i < previewLines.length - 1 ? `1px solid ${C.border}` : 'none',
                  lineHeight: 1.55,
                }}>{item}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: C.surface, borderTop: `1px solid ${C.border}`,
        display: 'flex', height: '64px',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {[
          { href: '/home',      label: 'Brief',   icon: '◆', active: true },
          { href: '/bookmarks', label: 'Saved',   icon: '★', active: false },
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
  )
}
