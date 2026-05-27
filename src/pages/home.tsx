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
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (data && !data.onboarding_complete) {
        router.push('/onboarding')
        return
      }
      setProfile(data)
      setLoading(false)
    }
    load()
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#F5F1EA',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '10px',
          letterSpacing: '3px', color: '#C8A45A'
        }}>LOADING YOUR BRIEF...</div>
      </div>
    )
  }

  const firstName = profile?.full_name?.split(' ')[0] || 'Reader'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>

      {/* Top bar */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '2px solid #C8A45A',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '52px'
      }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '18px',
          fontWeight: '700',
          fontStyle: 'italic',
          color: '#C8A45A'
        }}>Morning Brief</div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <Link href="/profile" style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '1px',
            color: '#888',
            textDecoration: 'none'
          }}>PROFILE</Link>
        </div>
      </div>

      {/* Greeting */}
      <div style={{
        background: '#1A1A1A',
        padding: '20px 20px 24px',
        borderBottom: '1px solid #2A2A2A'
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '9px',
          letterSpacing: '2px',
          color: '#555',
          marginBottom: '4px'
        }}>{today.toUpperCase()}</div>
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px',
          fontWeight: '400',
          fontStyle: 'italic',
          color: '#F5F1EA'
        }}>{greeting}, {firstName}.</h1>
      </div>

      {/* Main content */}
      <div style={{ padding: '24px 20px', maxWidth: '480px', margin: '0 auto' }}>

        {/* Brief card */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          borderTop: '3px solid #C8A45A',
          padding: '20px',
          marginBottom: '16px'
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '2px',
            color: '#C8A45A',
            marginBottom: '8px'
          }}>TODAY'S BRIEF</div>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '18px',
            fontWeight: '700',
            color: '#1A1A1A',
            marginBottom: '8px'
          }}>Your morning brief is being set up</div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            color: '#888',
            lineHeight: '1.6',
            marginBottom: '20px'
          }}>
            Your first personalised brief will be ready tomorrow at 7:00 AM IST.
            Today, explore the demo brief to see what's coming.
          </div>
          <Link href="/brief" style={{
            display: 'inline-block',
            padding: '12px 20px',
            background: '#1A1A1A',
            color: '#F5F1EA',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            fontWeight: '600',
            letterSpacing: '0.5px',
            textDecoration: 'none',
            borderRadius: '2px'
          }}>Read Demo Brief →</Link>
        </div>

        {/* Your profile summary */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          padding: '20px',
          marginBottom: '16px'
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '2px',
            color: '#888',
            marginBottom: '16px'
          }}>YOUR BRIEF IS PERSONALISED FOR</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { label: 'City', value: profile?.city_current },
              { label: 'Home', value: profile?.city_home },
              { label: 'Profession', value: `${profile?.profession}${profile?.company ? ` at ${profile?.company}` : ''}` },
              { label: 'Tone', value: profile?.mood_preference ? profile.mood_preference.charAt(0).toUpperCase() + profile.mood_preference.slice(1) : '' },
              { label: 'Depth', value: profile?.edition_preference === 'ultra' ? '5-min read' : profile?.edition_preference === 'standard' ? '10-min read' : 'Deep dive' },
            ].map(({ label, value }) => value ? (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '1px',
                  color: '#888'
                }}>{label.toUpperCase()}</span>
                <span style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '13px',
                  color: '#1A1A1A',
                  fontWeight: '500'
                }}>{value}</span>
              </div>
            ) : null)}
          </div>

          <Link href="/profile" style={{
            display: 'block',
            marginTop: '16px',
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '1px',
            color: '#C8A45A',
            textDecoration: 'none'
          }}>EDIT PROFILE →</Link>
        </div>

        {/* Coming soon */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          padding: '20px',
          marginBottom: '16px',
          opacity: 0.7
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '2px',
            color: '#888',
            marginBottom: '8px'
          }}>COMING SOON</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {['Daily Habit Tracker', 'Follow a Story', 'Friends Feed', 'Conversation Card'].map(f => (
              <div key={f} style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '13px',
                color: '#888',
                display: 'flex',
                gap: '8px',
                alignItems: 'center'
              }}>
                <span style={{ color: '#C8A45A', fontSize: '10px' }}>◆</span>
                {f}
              </div>
            ))}
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          style={{
            background: 'none',
            border: 'none',
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '1px',
            color: '#888',
            cursor: 'pointer',
            padding: '8px 0',
            textDecoration: 'underline',
            minHeight: '44px'
          }}
        >SIGN OUT</button>
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: '#1A1A1A',
        borderTop: '1px solid #2A2A2A',
        display: 'flex',
        height: '60px',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/habits', label: 'Habits', icon: '◎', active: false },
          { href: '/bookmarks', label: 'Saved', icon: '◈', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
            textDecoration: 'none',
            minHeight: '60px'
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#444' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px',
              letterSpacing: '1px',
              color: active ? '#C8A45A' : '#444'
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

      {/* Bottom nav spacer */}
      <div style={{ height: '80px' }} />
    </div>
  )
}
