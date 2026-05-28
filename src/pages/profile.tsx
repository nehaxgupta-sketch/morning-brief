 import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('standard')
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data) {
        setProfile(data)
        setMood(data.mood_preference || 'neutral')
        setEdition(data.edition_preference || 'standard')
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
      updated_at: new Date().toISOString()
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

  const sectionHead = {
    fontFamily: "'DM Mono', monospace" as const,
    fontSize: '9px', letterSpacing: '2px',
    color: '#888', marginBottom: '14px',
    textTransform: 'uppercase' as const
  }

  const row = (label: string, value: any) => value ? (
    <div key={label} style={{
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'flex-start', padding: '8px 0',
      borderBottom: '1px solid #F0EDE6', gap: '12px'
    }}>
      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#aaa', flexShrink: 0 }}>{label.toUpperCase()}</span>
      <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#1A1A1A', textAlign: 'right' }}>{value}</span>
    </div>
  ) : null

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA', paddingBottom: '80px' }}>

      {/* Header */}
      <div style={{
        background: '#1A1A1A', borderBottom: '2px solid #C8A45A',
        padding: '0 20px', display: 'flex',
        alignItems: 'center', height: '52px',
        position: 'sticky', top: 0, zIndex: 10
      }}>
        <Link href="/home" style={{
          color: '#666', textDecoration: 'none', fontSize: '20px',
          minHeight: '44px', display: 'flex', alignItems: 'center', marginRight: '16px'
        }}>←</Link>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '10px',
          letterSpacing: '2px', color: '#666'
        }}>YOUR PROFILE</div>
      </div>

      <div style={{ padding: '20px', maxWidth: '480px', margin: '0 auto' }}>

        {/* Name card */}
        <div style={{
          background: '#FDFCF9', border: '1px solid #E2DBD0',
          borderTop: '3px solid #C8A45A', padding: '20px', marginBottom: '14px'
        }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '22px', fontWeight: '700', color: '#1A1A1A', marginBottom: '2px'
          }}>{profile.full_name || 'Reader'}</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '10px',
            letterSpacing: '1px', color: '#aaa'
          }}>{profile.email}</div>
          <div style={{ marginTop: '6px' }}>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '9px',
              letterSpacing: '1px', color: '#888',
              background: '#F0EDE6', padding: '3px 8px', borderRadius: '2px'
            }}>
              {profile.brief_type === 'personalised' ? '◆ PERSONALISED BRIEF' : '◎ STANDARD BRIEF'}
            </span>
          </div>
        </div>

        {/* Personal details */}
        <div style={{
          background: '#FDFCF9', border: '1px solid #E2DBD0',
          padding: '20px', marginBottom: '14px'
        }}>
          <div style={sectionHead}>Personal</div>
          {row('Age', profile.age)}
          {row('Gender', profile.gender)}
          {row('Lives in', profile.city_current)}
          {row('From', profile.city_home !== profile.city_current ? profile.city_home : null)}
          {(profile as any).extra_cities?.length > 0 &&
            row('Also covers', (profile as any).extra_cities.join(', '))
          }
        </div>

        {/* Work details */}
        {((profile as any).life_stage || profile.industry) && (
          <div style={{
            background: '#FDFCF9', border: '1px solid #E2DBD0',
            padding: '20px', marginBottom: '14px'
          }}>
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
          <div style={{
            background: '#FDFCF9', border: '1px solid #E2DBD0',
            padding: '20px', marginBottom: '14px'
          }}>
            <div style={sectionHead}>Interests ({profile.interests.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {profile.interests.map(interest => (
                <span key={interest} style={{
                  padding: '4px 10px',
                  background: 'rgba(200,164,90,0.08)',
                  border: '1px solid rgba(200,164,90,0.25)',
                  borderRadius: '2px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '12px', color: '#C8A45A'
                }}>{interest}</span>
              ))}
            </div>
          </div>
        )}

        {/* Adjustable preferences */}
        <div style={{
          background: '#FDFCF9', border: '1px solid #E2DBD0',
          padding: '20px', marginBottom: '14px'
        }}>
          <div style={sectionHead}>Reading Preferences</div>

          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#aaa', marginBottom: '10px' }}>ANALYSIS TONE</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {['neutral', 'optimistic', 'critical'].map(m => (
                <button key={m} onClick={() => setMood(m)} style={{
                  flex: 1, padding: '11px 6px',
                  background: mood === m ? 'rgba(200,164,90,0.1)' : '#F5F1EA',
                  border: `1px solid ${mood === m ? '#C8A45A' : '#E2DBD0'}`,
                  borderRadius: '2px', cursor: 'pointer', minHeight: '44px'
                }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                    fontWeight: '600', color: mood === m ? '#C8A45A' : '#666',
                    textTransform: 'capitalize'
                  }}>{m}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#aaa', marginBottom: '10px' }}>DEFAULT DEPTH</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[
                { id: 'ultra', label: '5 Min' },
                { id: 'standard', label: '10 Min' },
                { id: 'deep', label: 'Deep' }
              ].map(e => (
                <button key={e.id} onClick={() => setEdition(e.id)} style={{
                  flex: 1, padding: '11px 6px',
                  background: edition === e.id ? 'rgba(200,164,90,0.1)' : '#F5F1EA',
                  border: `1px solid ${edition === e.id ? '#C8A45A' : '#E2DBD0'}`,
                  borderRadius: '2px', cursor: 'pointer', minHeight: '44px'
                }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                    fontWeight: '600', color: edition === e.id ? '#C8A45A' : '#666'
                  }}>{e.label}</div>
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleSave} disabled={saving} style={{
            width: '100%', padding: '14px',
            background: saved ? '#1B4332' : '#1A1A1A',
            color: '#F5F1EA',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px', fontWeight: '600',
            letterSpacing: '0.5px', border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            borderRadius: '2px', minHeight: '48px',
            transition: 'background 0.3s'
          }}>
            {saved ? '✓ Preferences Saved' : saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>

        {/* Edit full profile */}
        <Link href="/onboarding" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '14px', background: '#FDFCF9',
          border: '1px solid #E2DBD0', borderRadius: '2px',
          fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
          fontWeight: '500', color: '#444', textDecoration: 'none',
          marginBottom: '14px', minHeight: '48px'
        }}>
          Edit Full Profile →
        </Link>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          style={{
            width: '100%', padding: '14px',
            background: 'transparent',
            border: '1px solid #E8E4DC',
            color: signingOut ? '#aaa' : '#888',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px', fontWeight: '500',
            cursor: signingOut ? 'not-allowed' : 'pointer',
            borderRadius: '2px', minHeight: '48px'
          }}
        >
          {signingOut ? 'Signing out...' : 'Sign Out'}
        </button>
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: '#1A1A1A', borderTop: '1px solid #2A2A2A',
        display: 'flex', height: '60px',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: true },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '3px', textDecoration: 'none', minHeight: '60px'
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#666' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '8px',
              letterSpacing: '1px', color: active ? '#C8A45A' : '#666'
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
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
  prefer_not: 'Prefer not to say'
}