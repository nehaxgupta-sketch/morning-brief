
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

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

      // Which edition to look for
      const preferredEdition = (data?.edition_preference as string) || '5min'
      const editionToCheck = ['5min', '10min', 'deep'].includes(preferredEdition)
        ? preferredEdition : '5min'

      const isPersonalised = data?.brief_type === 'personalised'
      let content: any = null

      // Personalised users: check for their custom brief first
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

      // Fallback to the shared standard brief
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
    if (pref === '5min') return '5-minute'
    if (pref === 'deep') return 'deep dive'
    return '10-minute'
  }

  // ── Pull the teaser + counts out of today's brief content ──────────────
  const topHeadline: string | null = briefContent?.world?.[0]?.headline ?? null

  // Build a short "what's inside" summary line
  const sectionCounts: string[] = []
  if (briefContent) {
    const w = briefContent.world?.length ?? 0
    const i = briefContent.india?.length ?? 0
    if (w) sectionCounts.push(`🌍 ${w} world`)
    if (i) sectionCounts.push(`🇮🇳 ${i} India`)
    if (briefContent.markets?.indices?.length) sectionCounts.push('📈 Markets')
    if (briefContent.sport?.headline) sectionCounts.push('🏏 Sport')
    if (briefContent.culture?.headline) sectionCounts.push('🎭 Culture')
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA', paddingBottom: '72px' }}>

      {/* Header */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '2px solid #C8A45A',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '52px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '20px',
          fontWeight: '900',
          color: '#C8A45A',
        }}>Morning Brief</div>
        <Link href="/profile" style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '9px',
          letterSpacing: '1px',
          color: '#666',
          textDecoration: 'none',
          minHeight: '44px',
          display: 'flex',
          alignItems: 'center',
        }}>PROFILE</Link>
      </div>

      {/* Greeting */}
      <div style={{ background: '#1A1A1A', padding: '16px 20px 20px' }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '9px',
          letterSpacing: '2px',
          color: '#666',
          marginBottom: '4px',
        }}>{today.toUpperCase()}</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '20px',
          color: '#F5F1EA',
        }}>{greeting}, {firstName}.</div>
      </div>

      <div style={{ padding: '20px', maxWidth: '480px', margin: '0 auto' }}>

        {/* Brief card */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          borderTop: '3px solid #C8A45A',
          padding: '20px',
          marginBottom: '16px',
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '2px',
            color: '#C8A45A',
            marginBottom: '8px',
          }}>TODAY'S BRIEF</div>

          {briefReady ? (
            // ── Brief is ready ──────────────────────────────────────────
            <>
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '9px',
                letterSpacing: '1px',
                color: '#999',
                marginBottom: '10px',
              }}>
                YOUR {editionLabel(profile?.edition_preference as string || '10min').toUpperCase()} BRIEF IS READY
                {isPersonalised ? ' · PERSONALISED' : ''}
              </div>

              {/* Top headline teaser */}
              {topHeadline ? (
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '20px',
                  fontWeight: '700',
                  color: '#1A1A1A',
                  lineHeight: '1.35',
                  marginBottom: '12px',
                }}>{topHeadline}</div>
              ) : (
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '18px',
                  fontWeight: '700',
                  color: '#1A1A1A',
                  marginBottom: '12px',
                }}>Your brief is ready</div>
              )}

              {/* What's inside */}
              {sectionCounts.length > 0 && (
                <div style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '13px',
                  color: '#777',
                  lineHeight: '1.6',
                  marginBottom: '20px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '4px 12px',
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
                padding: '14px 20px',
                background: '#1A1A1A',
                color: '#F5F1EA',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px',
                fontWeight: '600',
                letterSpacing: '0.5px',
                textDecoration: 'none',
                borderRadius: '2px',
              }}>Read Today's Brief →</Link>
            </>
          ) : (
            // ── Brief not yet ready ─────────────────────────────────────
            <>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: '18px',
                fontWeight: '700',
                color: '#1A1A1A',
                marginBottom: '8px',
              }}>Your brief is being prepared</div>
              <div style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px',
                color: '#888',
                lineHeight: '1.6',
                marginBottom: '20px',
              }}>
                {isPersonalised
                  ? `Your personalised brief — tailored to ${profile?.city_current || 'your city'} and your interests — will be ready tomorrow at 6:45 AM.`
                  : 'Your standard brief covering top world and India stories will be ready tomorrow at 6:45 AM.'
                }
              </div>

              {isPersonalised && (
                <div style={{
                  background: '#F5F1EA',
                  border: '1px solid #E2DBD0',
                  padding: '14px',
                  marginBottom: '20px',
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: '8px',
                    letterSpacing: '2px',
                    color: '#888',
                    marginBottom: '8px',
                  }}>YOUR BRIEF WILL COVER</div>
                  {[
                    `📍 ${[profile?.city_current, profile?.city_home].filter(Boolean).join(' & ')} local news`,
                    '🌍 World affairs, India politics, geopolitics',
                    `💼 Business & markets — ${profile?.industry || (profile as any)?.work_area || 'tailored to your field'}`,
                    profile?.interests?.length ? `🎯 ${profile.interests.slice(0, 3).join(', ')}` : null,
                    `📖 ${editionLabel(profile?.edition_preference as string || '10min')} depth · ${profile?.mood_preference || 'Neutral'} lens`,
                  ].filter(Boolean).map((item, i) => (
                    <div key={i} style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '13px',
                      color: '#555',
                      padding: '5px 0',
                      borderBottom: '1px solid #EDE8DF',
                      lineHeight: '1.4',
                    }}>{item}</div>
                  ))}
                </div>
              )}

              <Link href="/brief" style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '13px 20px',
                background: '#1A1A1A',
                color: '#F5F1EA',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '13px',
                fontWeight: '600',
                letterSpacing: '0.5px',
                textDecoration: 'none',
                borderRadius: '2px',
              }}>Read Demo Brief →</Link>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: '#1A1A1A',
        borderTop: '1px solid #2A2A2A',
        display: 'flex',
        height: '60px',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/bookmarks', label: 'Saved', icon: '◈', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '3px', textDecoration: 'none', minHeight: '60px',
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#666' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px',
              letterSpacing: '1px',
              color: active ? '#C8A45A' : '#666',
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
}
