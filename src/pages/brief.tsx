 import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

export default function BriefPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      setProfile(data)
    }
    load()
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>

      {/* Header */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '3px solid #C8A45A',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '52px',
        position: 'sticky',
        top: 0,
        zIndex: 10
      }}>
        <Link href="/home" style={{
          color: '#888', textDecoration: 'none',
          fontSize: '18px', minHeight: '44px',
          display: 'flex', alignItems: 'center'
        }}>←</Link>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '18px',
          fontWeight: '700',
          fontStyle: 'italic',
          color: '#C8A45A'
        }}>Morning Brief</div>
        <div style={{ width: '44px' }} />
      </div>

      {/* Masthead */}
      <div style={{
        background: '#1A1A1A',
        padding: '16px 20px 20px',
        borderBottom: '1px solid #2A2A2A'
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '8px',
          letterSpacing: '2px',
          color: '#555',
          marginBottom: '2px'
        }}>{today.toUpperCase()}</div>
        {profile && (
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '8px',
            letterSpacing: '1px',
            color: '#444'
          }}>
            {profile.city_current?.toUpperCase()} · {profile.profession?.toUpperCase()} · {(profile.mood_preference || 'NEUTRAL').toUpperCase()} LENS
          </div>
        )}
      </div>

      {/* Demo notice */}
      <div style={{
        background: 'rgba(200,164,90,0.1)',
        borderBottom: '1px solid rgba(200,164,90,0.2)',
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}>
        <span style={{ color: '#C8A45A', fontSize: '12px' }}>◆</span>
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '12px',
          color: '#888'
        }}>Demo brief — your personalised edition starts tomorrow at 7 AM</span>
      </div>

      {/* Brief content — loads the existing morning brief component */}
      <div style={{ padding: '0 0 80px' }}>
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '18px',
            fontStyle: 'italic',
            color: '#888',
            marginBottom: '8px'
          }}>Your brief is being configured</div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            color: '#aaa',
            lineHeight: '1.6',
            maxWidth: '280px',
            margin: '0 auto 20px'
          }}>
            The AI engine is learning your profile. Your first fully personalised brief — tailored to {profile?.city_current || 'your city'}, your profession, and your interests — will be ready tomorrow morning.
          </div>
          <div style={{
            background: '#FDFCF9',
            border: '1px solid #E2DBD0',
            borderTop: '2px solid #C8A45A',
            padding: '16px',
            textAlign: 'left',
            marginBottom: '12px'
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px',
              letterSpacing: '2px',
              color: '#C8A45A',
              marginBottom: '8px'
            }}>YOUR BRIEF WILL COVER</div>
            {[
              `📍 Local news for ${profile?.city_current || 'your city'} and ${profile?.city_home || 'your home city'}`,
              '🌍 World affairs, India politics, geopolitics',
              `💼 Business & markets through a ${profile?.industry || 'finance'} lens`,
              `🎯 ${(profile?.interests || []).slice(0, 3).join(', ') || 'Your interests'}`,
              `📖 In ${profile?.edition_preference === 'ultra' ? '5-minute' : profile?.edition_preference === 'deep' ? 'deep dive' : '10-minute'} depth`,
              `🔍 With ${profile?.mood_preference || 'neutral'} analysis tone`,
            ].map(item => (
              <div key={item} style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '13px',
                color: '#444',
                padding: '6px 0',
                borderBottom: '1px solid #F0EDE6',
                lineHeight: '1.4'
              }}>{item}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: '#1A1A1A',
        borderTop: '1px solid #2A2A2A',
        display: 'flex',
        height: '60px'
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/habits', label: 'Habits', icon: '◎', active: false },
          { href: '/bookmarks', label: 'Saved', icon: '◈', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '2px', textDecoration: 'none', minHeight: '60px'
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#444' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px', letterSpacing: '1px',
              color: active ? '#C8A45A' : '#444'
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
