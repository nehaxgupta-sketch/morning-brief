import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)', goldBorder: 'rgba(200,164,90,0.40)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
  ok: '#3A6F4F',
}

const LIFE_STAGE_LABELS: Record<string, string> = {
  student: 'Student',
  early_career: 'Early Career (0–5 yrs)',
  mid_career: 'Mid Career (5–15 yrs)',
  senior: 'Senior Professional (15+ yrs)',
  business: 'Business Owner',
  freelancer: 'Freelancer / Consultant',
  homemaker: 'Homemaker',
  retired: 'Retired',
  prefer_not: 'Prefer not to say',
}

// Edition picker labels — internal IDs stay 5min/10min/deep.
const EDITION_OPTIONS = [
  { id: '5min',  label: 'The Brief',     sub: '5 min · skim' },
  { id: '10min', label: 'The Daily',     sub: '10 min · full read' },
  { id: 'deep',  label: 'The Editorial', sub: '15 min · synthesis' },
]

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('10min')
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data) {
        setProfile(data)
        setMood(data.mood_preference || 'neutral')
        const pref = data.edition_preference
        if (pref === 'ultra' || pref === '5min') setEdition('5min')
        else if (pref === 'deep') setEdition('deep')
        else setEdition('10min')
      }
    }
    load()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('profiles').update({
      mood_preference: mood,
      edition_preference: edition,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    await supabase.auth.signOut()
    router.push('/')
  }

  if (!profile) return null

  const sectionHead: React.CSSProperties = {
    fontFamily: "'DM Mono', monospace",
    fontSize: '10px', letterSpacing: '2px',
    color: C.gold, marginBottom: '16px',
    textTransform: 'uppercase',
  }

  const row = (label: string, value: any) => value ? (
    <div key={label} style={{
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'flex-start', padding: '10px 0',
      borderBottom: `1px solid ${C.border}`, gap: '14px',
    }}>
      <span style={{
        fontFamily: "'DM Mono', monospace", fontSize: '10px',
        letterSpacing: '1.5px', color: C.textMute, flexShrink: 0,
      }}>{label.toUpperCase()}</span>
      <span style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
        color: C.text, textAlign: 'right', lineHeight: 1.5,
      }}>{value}</span>
    </div>
  ) : null

  const cardStyle: React.CSSProperties = {
    background: C.surface,
    border: `1px solid ${C.border}`,
    padding: '22px',
    marginBottom: '16px',
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: '88px' }}>
      {/* Header */}
      <div style={{
        background: C.bg, borderBottom: `2px solid ${C.gold}`,
        padding: '0 20px', display: 'flex',
        alignItems: 'center', height: '56px',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <Link href="/home" style={{
          color: C.textMute, textDecoration: 'none', fontSize: '22px',
          minHeight: '44px', display: 'flex', alignItems: 'center', marginRight: '18px',
        }}>←</Link>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '11px',
          letterSpacing: '2.5px', color: C.gold,
        }}>YOUR PROFILE</div>
      </div>

      <div style={{ padding: '20px', maxWidth: '480px', margin: '0 auto' }}>
        {/* Name card */}
        <div style={{ ...cardStyle, borderTop: `3px solid ${C.gold}` }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '26px', fontWeight: 700, color: C.text,
            marginBottom: '4px', lineHeight: 1.25,
          }}>{profile.full_name || 'Reader'}</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.2px', color: C.textMute, marginBottom: '12px',
          }}>{profile.email}</div>
          <div>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.gold,
              background: C.goldSoft, border: `1px solid ${C.goldBorder}`,
              padding: '5px 10px', borderRadius: '2px',
            }}>
              {profile.brief_type === 'personalised' ? '◆ PERSONALISED BRIEF' : '◎ STANDARD BRIEF'}
            </span>
          </div>
        </div>

        {/* Personal */}
        <div style={cardStyle}>
          <div style={sectionHead}>Personal</div>
          {row('Age', profile.age)}
          {row('Gender', profile.gender)}
          {row('Lives in', profile.city_current)}
          {row('From', profile.city_home !== profile.city_current ? profile.city_home : null)}
          {(profile as any).extra_cities?.length > 0 &&
            row('Also covers', (profile as any).extra_cities.join(', '))
          }
        </div>

        {/* Work & Study */}
        {((profile as any).life_stage || profile.industry) && (
          <div style={cardStyle}>
            <div style={sectionHead}>Work & Study</div>
            {row('Status', LIFE_STAGE_LABELS[(profile as any).life_stage] || (profile as any).life_stage)}
            {row('Area', (profile as any).work_area || (profile as any).study_area)}
            {row('Industry', profile.industry)}
            {row('Company', profile.company)}
            {row('Study level', (profile as any).study_level)}
          </div>
        )}

        {/* Interests */}
        {profile.interests?.length > 0 && (
          <div style={cardStyle}>
            <div style={sectionHead}>Interests ({profile.interests.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {profile.interests.map(interest => (
                <span key={interest} style={{
                  padding: '6px 12px',
                  background: C.goldSoft,
                  border: `1px solid ${C.goldBorder}`,
                  borderRadius: '2px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '13px', color: C.gold,
                }}>{interest}</span>
              ))}
            </div>
            <div style={{
              marginTop: '14px',
              fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
              color: C.textMute, lineHeight: 1.6,
            }}>
              To change your interests, tap "Edit Full Profile" below.
            </div>
          </div>
        )}

        {/* Reading Preferences */}
        <div style={cardStyle}>
          <div style={sectionHead}>Reading Preferences</div>

          <div style={{ marginBottom: '22px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.textMute, marginBottom: '12px',
            }}>ANALYSIS TONE</div>
            <div style={{ display: 'flex', gap: '10px' }}>
              {['neutral', 'optimistic', 'critical'].map(m => (
                <button key={m} onClick={() => setMood(m)} style={{
                  flex: 1, padding: '14px 6px',
                  background: mood === m ? C.goldSoft : C.surface2,
                  border: `1px solid ${mood === m ? C.gold : C.border}`,
                  borderRadius: '2px', cursor: 'pointer', minHeight: '48px',
                }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                    fontWeight: 600, color: mood === m ? C.gold : C.textSoft,
                    textTransform: 'capitalize',
                  }}>{m}</div>
                </button>
              ))}
            </div>
            <div style={{
              marginTop: '10px',
              fontFamily: "'DM Sans', sans-serif", fontSize: '11px',
              color: C.textDim, lineHeight: 1.55,
              fontStyle: 'italic',
            }}>
              Tone preference is saved but doesn't change the brief content yet.
            </div>
          </div>

          <div style={{ marginBottom: '22px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.textMute, marginBottom: '12px',
            }}>DEFAULT EDITION</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {EDITION_OPTIONS.map(e => (
                <button key={e.id} onClick={() => setEdition(e.id)} style={{
                  padding: '14px 16px', textAlign: 'left',
                  background: edition === e.id ? C.goldSoft : C.surface2,
                  border: `1px solid ${edition === e.id ? C.gold : C.border}`,
                  borderRadius: '2px', cursor: 'pointer', minHeight: '54px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                }}>
                  <div>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '16px', fontWeight: 700,
                      color: edition === e.id ? C.gold : C.text,
                      marginBottom: '2px',
                    }}>{e.label}</div>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px', color: C.textMute,
                    }}>{e.sub.toUpperCase()}</div>
                  </div>
                  {edition === e.id && (
                    <span style={{ color: C.gold, fontSize: '14px' }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleSave} disabled={saving} style={{
            width: '100%', padding: '16px',
            background: saved ? C.ok : C.gold,
            color: saved ? C.text : '#0E0E0E',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px', fontWeight: 700,
            letterSpacing: '1.5px', border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            borderRadius: '2px', minHeight: '54px',
            textTransform: 'uppercase',
            transition: 'background 0.25s',
            opacity: saving ? 0.7 : 1,
          }}>
            {saved ? '✓ Preferences Saved' : saving ? 'Saving…' : 'Save Preferences'}
          </button>
        </div>

        {/* Edit full profile */}
        <Link href="/onboarding" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px', background: C.surface,
          border: `1px solid ${C.border}`, borderRadius: '2px',
          fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
          fontWeight: 500, color: C.textSoft, textDecoration: 'none',
          marginBottom: '16px', minHeight: '54px',
        }}>
          Edit Full Profile →
        </Link>

        {/* Sign out */}
        <button onClick={handleSignOut} disabled={signingOut} style={{
          width: '100%', padding: '16px',
          background: 'transparent',
          border: `1px solid ${C.border}`,
          color: signingOut ? C.textDim : C.textMute,
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px', fontWeight: 500,
          cursor: signingOut ? 'not-allowed' : 'pointer',
          borderRadius: '2px', minHeight: '54px',
        }}>
          {signingOut ? 'Signing out…' : 'Sign Out'}
        </button>
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
          { href: '/bookmarks', label: 'Saved',   icon: '★', active: false },
          { href: '/profile',   label: 'Profile', icon: '◑', active: true  },
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
