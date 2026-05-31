import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E',
  surface: '#161616',
  surface2: '#1E1E1E',
  border: '#262626',
  borderHi: '#3A3A3A',
  gold: '#C8A45A',
  goldSoft: 'rgba(200,164,90,0.10)',
  text: '#F5F1EA',
  textSoft: '#CFC6B8',
  textMute: '#8E867B',
  textDim: '#5E574D',
}

export default function Home() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [briefReady, setBriefReady] = useState(false)
  const [briefContent, setBriefContent] = useState<any>(null)

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })
  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }

      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data && !data.onboarding_complete) { window.location.href = '/onboarding'; return }
      setProfile(data)

      const rawPref = (data?.edition_preference as string) || '10min'
      const normalised = rawPref === 'ultra' ? '5min' : rawPref
      const editionToCheck = ['5min', '10min', 'deep'].includes(normalised)
        ? normalised : '10min'

      const isPersonalised = data?.brief_type === 'personalised'
      let content: any = null

      if (isPersonalised) {
        const { data: personalised } = await supabase
          .from('personalised_briefs')
          .select('content')
          .eq('user_id', user.id)
          .eq('date', todayISO)
          .eq('edition', editionToCheck)
          .eq('status', 'ready')
          .single()
        if (personalised?.content) content = personalised.content
      }

      if (!content) {
        const { data: briefData } = await supabase
          .from('briefs')
          .select('content')
          .eq('date', todayISO)
          .eq('edition', editionToCheck)
          .eq('status', 'ready')
          .single()
        if (briefData?.content) content = briefData.content
      }

      setBriefReady(!!content)
      setBriefContent(content)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return null

  const firstName = profile?.full_name?.split(' ')[0] || 'Reader'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const isPersonalised = profile?.brief_type === 'personalised'

  const editionLabel = (pref: string) => {
    const p = pref === 'ultra' ? '5min' : pref
    if (p === '5min') return '5-minute'
    if (p === 'deep') return 'deep dive'
    return '10-minute'
  }

  // Prefer major_events for the headline teaser, fall back to world[0]
  const topHeadline: string | null =
    briefContent?.major_events?.[0]?.headline
    ?? briefContent?.world?.[0]?.headline
    ?? null

  // What's inside summary
  const sectionCounts: string[] = []
  if (briefContent) {
    const m = briefContent.major_events?.length ?? 0
    const w = briefContent.world?.length ?? 0
    const i = briefContent.india?.length ?? 0
    const ps = briefContent.personal_sections?.length ?? 0
    if (m) sectionCounts.push(`🔥 ${m} major`)
    if (w) sectionCounts.push(`🌍 ${w} world`)
    if (i) sectionCounts.push(`🇮🇳 ${i} India`)
    if (ps) sectionCounts.push(`📍 ${ps} for you`)
    if (briefContent.markets?.indices?.length) sectionCounts.push('📈 Markets')
    if (briefContent.sport?.headline) sectionCounts.push('🏏 Sport')
    if (briefContent.culture?.headline) sectionCounts.push('🎭 Culture')
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: '80px' }}>

      {/* Header */}
      <div style={{
        background: C.bg,
        borderBottom: `2px solid ${C.gold}`,
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '56px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px',
          fontWeight: 900,
          color: C.gold,
          letterSpacing: '0.2px',
        }}>Morning Brief</div>
        <Link href="/profile" style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '1.5px',
          color: C.textMute,
          textDecoration: 'none',
          minHeight: '44px',
          display: 'flex',
          alignItems: 'center',
        }}>PROFILE</Link>
      </div>

      {/* Greeting */}
      <div style={{ background: C.bg, padding: '20px 20px 24px' }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '2px',
          color: C.textMute,
          marginBottom: '6px',
        }}>{today.toUpperCase()}</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '24px',
          fontWeight: 700,
          color: C.text,
          lineHeight: 1.3,
        }}>{greeting}, {firstName}.</div>
      </div>

      <div style={{ padding: '0 20px', maxWidth: '480px', margin: '0 auto' }}>

        {/* Brief card */}
        <div style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderTop: `3px solid ${C.gold}`,
          padding: '22px',
          marginBottom: '20px',
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '10px',
            letterSpacing: '2px',
            color: C.gold,
            marginBottom: '12px',
          }}>TODAY'S BRIEF</div>

          {briefReady ? (
            <>
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                letterSpacing: '1.5px',
                color: C.textMute,
                marginBottom: '14px',
              }}>
                YOUR {editionLabel(profile?.edition_preference as string || '10min').toUpperCase()} BRIEF IS READY
                {isPersonalised ? ' · PERSONALISED' : ''}
              </div>

              {topHeadline ? (
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '22px',
                  fontWeight: 700,
                  color: C.text,
                  lineHeight: 1.35,
                  marginBottom: '16px',
                }}>{topHeadline}</div>
              ) : (
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '20px',
                  fontWeight: 700,
                  color: C.text,
                  marginBottom: '16px',
                }}>Your brief is ready</div>
              )}

              {sectionCounts.length > 0 && (
                <div style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  color: C.textSoft,
                  lineHeight: 1.7,
                  marginBottom: '22px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px 14px',
                }}>
                  {sectionCounts.map((s, i) => (
                    <span key={i}>{s}</span>
                  ))}
                </div>
              )}

              <Link href="/brief" style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px 20px',
                background: C.gold,
                color: '#0E0E0E',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px',
                fontWeight: 700,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                textDecoration: 'none',
                minHeight: '52px',
              }}>Read Today's Brief →</Link>
            </>
          ) : (
            <>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: '20px',
                fontWeight: 700,
                color: C.text,
                marginBottom: '12px',
                lineHeight: 1.35,
              }}>Your brief is being prepared</div>
              <div style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '15px',
                color: C.textSoft,
                lineHeight: 1.7,
                marginBottom: '22px',
              }}>
                {isPersonalised
                  ? `Your personalised brief — tailored to ${profile?.city_current || 'your city'} and your interests — will be ready tomorrow at 6:45 AM.`
                  : 'Your standard brief covering today\'s biggest stories will be ready tomorrow at 6:45 AM.'
                }
              </div>

              {isPersonalised && (
                <div style={{
                  background: C.surface2,
                  border: `1px solid ${C.border}`,
                  padding: '16px',
                  marginBottom: '22px',
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: '10px',
                    letterSpacing: '2px',
                    color: C.gold,
                    marginBottom: '10px',
                  }}>YOUR BRIEF WILL COVER</div>
                  {[
                    `📍 ${[profile?.city_current, profile?.city_home].filter(Boolean).join(' & ') || 'Your city'}`,
                    '🔥 Major events worth tracking',
                    '🌍 World & India politics',
                    `💼 Markets · ${profile?.industry || (profile as any)?.work_area || 'your field'}`,
                    profile?.interests?.length ? `🎯 ${profile.interests.slice(0, 3).join(', ')}` : null,
                    `📖 ${editionLabel(profile?.edition_preference as string || '10min')} · ${profile?.mood_preference || 'Neutral'} lens`,
                  ].filter(Boolean).map((item, i) => (
                    <div key={i} style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '14px',
                      color: C.textSoft,
                      padding: '8px 0',
                      borderBottom: `1px solid ${C.border}`,
                      lineHeight: 1.55,
                    }}>{item}</div>
                  ))}
                </div>
              )}

              <Link href="/brief" style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px 20px',
                background: 'transparent',
                color: C.gold,
                border: `1px solid ${C.gold}`,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px',
                fontWeight: 700,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                textDecoration: 'none',
                minHeight: '52px',
              }}>Read Demo Brief →</Link>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: C.surface,
        borderTop: `1px solid ${C.border}`,
        display: 'flex',
        height: '64px',
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
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '1.5px',
              color: active ? C.gold : C.textMute,
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
}
