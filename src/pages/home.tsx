import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

export default function Home() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data && !data.onboarding_complete) { window.location.href = '/onboarding'; return }
      setProfile(data)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return null

  const firstName = profile?.full_name?.split(' ')[0] || 'Reader'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const isPersonalised = profile?.brief_type === 'personalised'

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA', paddingBottom: '72px' }}>

      <div style={{ background: '#1A1A1A', borderBottom: '2px solid #C8A45A', padding: '0 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '52px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: '20px', fontWeight: '900', color: '#C8A45A' }}>Morning Brief</div>
        <Link href="/profile" style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#555', textDecoration: 'none', minHeight: '44px', display: 'flex', alignItems: 'center' }}>PROFILE</Link>
      </div>

      <div style={{ background: '#1A1A1A', padding: '16px 20px 20px' }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '8px', letterSpacing: '2px', color: '#888', marginBottom: '4px' }}>{today.toUpperCase()}</div>
        <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: '20px', color: '#F5F1EA' }}>{greeting}, {firstName}.</div>
      </div>

      <div style={{ padding: '20px', maxWidth: '480px', margin: '0 auto' }}>
        <div style={{ background: '#FDFCF9', border: '1px solid #E2DBD0', borderTop: '3px solid #C8A45A', padding: '20px', marginBottom: '16px' }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '8px' }}>TODAY'S BRIEF</div>
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: '18px', fontWeight: '700', color: '#1A1A1A', marginBottom: '8px' }}>Your brief is being prepared</div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#888', lineHeight: '1.6', marginBottom: '20px' }}>
            {isPersonalised
              ? `Your first personalised brief — tailored to ${profile?.city_current || 'your city'} and your interests — will be ready tomorrow at 7:00 AM IST.`
              : 'Your standard brief covering top world and India stories will be ready tomorrow at 7:00 AM IST.'}
          </div>

          {isPersonalised && (
            <div style={{ background: '#F5F1EA', border: '1px solid #E2DBD0', padding: '14px', marginBottom: '20px' }}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '8px', letterSpacing: '2px', color: '#888', marginBottom: '8px' }}>YOUR BRIEF WILL COVER</div>
              {[
                `📍 ${[profile?.city_current, profile?.city_home].filter(Boolean).join(' & ')} local news`,
                '🌍 World affairs, India politics, geopolitics',
                `💼 Business & markets — ${profile?.industry || (profile as any)?.work_area || 'tailored to your field'}`,
                profile?.interests?.length ? `🎯 ${profile.interests.slice(0, 3).join(', ')}` : null,
                `📖 ${profile?.edition_preference === 'ultra' ? '5-minute' : profile?.edition_preference === 'deep' ? 'Deep dive' : '10-minute'} depth · ${profile?.mood_preference || 'Neutral'} lens`
              ].filter(Boolean).map((item, i) => (
                <div key={i} style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#555', padding: '5px 0', borderBottom: '1px solid #EDE8DF', lineHeight: '1.4' }}>{item}</div>
              ))}
            </div>
          )}

          <Link href="/brief" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '13px 20px', background: '#1A1A1A', color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', fontWeight: '600', letterSpacing: '0.5px', textDecoration: 'none', borderRadius: '2px' }}>Read Demo Brief →</Link>
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#1A1A1A', borderTop: '1px solid #2A2A2A', display: 'flex', height: '60px', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3px', textDecoration: 'none', minHeight: '60px' }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#666' }}>{icon}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '8px', letterSpacing: '1px', color: active ? '#C8A45A' : '#666' }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}