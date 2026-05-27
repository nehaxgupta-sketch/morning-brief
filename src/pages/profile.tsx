import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

const MOODS = [
  { id: 'neutral', label: 'Neutral', desc: 'Balanced, objective' },
  { id: 'optimistic', label: 'Optimistic', desc: 'Forward-looking lens' },
  { id: 'critical', label: 'Critical', desc: 'Sharper analysis' },
]

const EDITIONS = [
  { id: 'ultra', label: '5 Minutes', desc: 'Quick headlines' },
  { id: 'standard', label: '10 Minutes', desc: 'Full stories' },
  { id: 'deep', label: 'Deep Dive', desc: 'Complete analysis' },
]

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('standard')

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
    setTimeout(() => setSaved(false), 2000)
  }

  if (!profile) return null

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>
      {/* Header */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '2px solid #C8A45A',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        height: '52px'
      }}>
        <Link href="/home" style={{ color: '#888', textDecoration: 'none', fontSize: '18px', minHeight: '44px', display: 'flex', alignItems: 'center' }}>←</Link>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '2px',
          color: '#888'
        }}>YOUR PROFILE</div>
      </div>

      <div style={{ padding: '24px 20px', maxWidth: '480px', margin: '0 auto' }}>

        {/* Name / info */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          borderTop: '3px solid #C8A45A',
          padding: '20px',
          marginBottom: '16px'
        }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '22px',
            fontWeight: '700',
            color: '#1A1A1A',
            marginBottom: '4px'
          }}>{profile.full_name}</div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            color: '#888'
          }}>{profile.email}</div>

          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { label: 'Age', value: profile.age },
              { label: 'Gender', value: profile.gender },
              { label: 'Lives in', value: profile.city_current },
              { label: 'From', value: profile.city_home },
              { label: 'Role', value: profile.profession },
              { label: 'Industry', value: profile.industry },
              { label: 'Company', value: profile.company },
            ].map(({ label, value }) => value ? (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#888' }}>{label.toUpperCase()}</span>
                <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#1A1A1A' }}>{value}</span>
              </div>
            ) : null)}
          </div>

          <Link href="/onboarding" style={{
            display: 'block',
            marginTop: '16px',
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '1px',
            color: '#C8A45A',
            textDecoration: 'none'
          }}>EDIT ALL DETAILS →</Link>
        </div>

        {/* Interests */}
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
            marginBottom: '12px'
          }}>YOUR INTERESTS</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {(profile.interests || []).map(interest => (
              <span key={interest} style={{
                padding: '4px 10px',
                background: 'rgba(200,164,90,0.1)',
                border: '1px solid rgba(200,164,90,0.3)',
                borderRadius: '2px',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '12px',
                color: '#C8A45A'
              }}>{interest}</span>
            ))}
          </div>
        </div>

        {/* Adjustable preferences */}
        <div style={{
          background: '#FDFCF9',
          border: '1px solid #E2DBD0',
          padding: '20px',
          marginBottom: '24px'
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '2px',
            color: '#888',
            marginBottom: '20px'
          }}>READING PREFERENCES</div>

          {/* Mood */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '1px',
              color: '#888',
              marginBottom: '10px'
            }}>ANALYSIS TONE</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {MOODS.map(m => (
                <button key={m.id} onClick={() => setMood(m.id)} style={{
                  flex: 1,
                  padding: '10px 8px',
                  background: mood === m.id ? 'rgba(200,164,90,0.1)' : '#F5F1EA',
                  border: `1px solid ${mood === m.id ? '#C8A45A' : '#E2DBD0'}`,
                  borderRadius: '2px',
                  cursor: 'pointer',
                  minHeight: '44px'
                }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '12px',
                    fontWeight: '600',
                    color: mood === m.id ? '#C8A45A' : '#444'
                  }}>{m.label}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Edition */}
          <div>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '1px',
              color: '#888',
              marginBottom: '10px'
            }}>DEFAULT DEPTH</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {EDITIONS.map(e => (
                <button key={e.id} onClick={() => setEdition(e.id)} style={{
                  flex: 1,
                  padding: '10px 8px',
                  background: edition === e.id ? 'rgba(200,164,90,0.1)' : '#F5F1EA',
                  border: `1px solid ${edition === e.id ? '#C8A45A' : '#E2DBD0'}`,
                  borderRadius: '2px',
                  cursor: 'pointer',
                  minHeight: '44px'
                }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '11px',
                    fontWeight: '600',
                    color: edition === e.id ? '#C8A45A' : '#444'
                  }}>{e.label}</div>
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleSave} disabled={saving} style={{
            marginTop: '20px',
            width: '100%',
            padding: '14px',
            background: saved ? '#1B4332' : '#1A1A1A',
            color: '#F5F1EA',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            fontWeight: '600',
            letterSpacing: '1px',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '2px',
            minHeight: '48px',
            transition: 'background 0.3s'
          }}>
            {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </div>
    </div>
  )
}
