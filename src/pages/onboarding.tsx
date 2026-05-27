import { useState } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'

// ── Data ──────────────────────────────────────────────────────────────
const CITIES = [
  'Bengaluru', 'Delhi', 'Mumbai', 'Hyderabad', 'Chennai',
  'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Other'
]

const INDUSTRIES = [
  'Technology', 'Finance & Banking', 'Consulting', 'Healthcare',
  'Media & Entertainment', 'Education', 'Government & Policy',
  'Retail & E-commerce', 'Manufacturing', 'Real Estate',
  'Legal', 'Marketing & Advertising', 'Other'
]

const INTERESTS = [
  'Books & Reading', 'Movies & Cinema', 'Music', 'Travel',
  'Food & Cooking', 'Fitness & Wellness', 'Cricket', 'Football',
  'Technology', 'Investing & Personal Finance', 'Art & Design',
  'Photography', 'Gaming', 'Politics & Policy', 'Environment',
  'Fashion & Style', 'Startups & Entrepreneurship', 'Spirituality'
]

const MOODS = [
  {
    id: 'neutral',
    label: 'Neutral',
    desc: 'Balanced, objective framing. Facts first.',
    icon: '◎'
  },
  {
    id: 'optimistic',
    label: 'Optimistic',
    desc: 'Same facts, forward-looking lens. What could go right.',
    icon: '◑'
  },
  {
    id: 'critical',
    label: 'Critical',
    desc: 'Sharper analysis. Questions assumptions.',
    icon: '◐'
  }
]

const EDITIONS = [
  { id: 'ultra', label: '5 Minutes', desc: 'Quick headlines before you start your day', icon: '⚡' },
  { id: 'standard', label: '10 Minutes', desc: 'Full stories with context, expandable depth', icon: '◆' },
  { id: 'deep', label: 'Deep Dive', desc: 'Complete analysis with facts and expert opinion', icon: '◈' },
]

// ── Step indicator ────────────────────────────────────────────────────
function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginBottom: '32px' }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: i === current ? '20px' : '6px',
          height: '6px',
          borderRadius: '3px',
          background: i <= current ? '#C8A45A' : '#333',
          transition: 'all 0.3s ease'
        }} />
      ))}
    </div>
  )
}

// ── Chip selector ─────────────────────────────────────────────────────
function Chip({
  label, selected, onToggle
}: { label: string; selected: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        padding: '8px 14px',
        background: selected ? '#C8A45A' : '#2A2A2A',
        color: selected ? '#1A1A1A' : '#888',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '13px',
        fontWeight: selected ? '600' : '400',
        border: `1px solid ${selected ? '#C8A45A' : '#333'}`,
        borderRadius: '2px',
        cursor: 'pointer',
        transition: 'all 0.2s',
        minHeight: '40px',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  )
}

// ── Select input ──────────────────────────────────────────────────────
function SelectInput({
  label, value, onChange, options
}: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <label style={{
        display: 'block',
        fontFamily: "'DM Mono', monospace",
        fontSize: '9px',
        letterSpacing: '2px',
        color: '#888',
        marginBottom: '8px',
        textTransform: 'uppercase'
      }}>{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '14px 16px',
          background: '#2A2A2A',
          border: `1px solid ${value ? '#C8A45A' : '#333'}`,
          color: value ? '#F5F1EA' : '#555',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          outline: 'none',
          borderRadius: '2px',
          appearance: 'none',
          cursor: 'pointer'
        }}
      >
        <option value="">Select...</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

// ── Text input ────────────────────────────────────────────────────────
function TextInput({
  label, value, onChange, placeholder, type = 'text'
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label style={{
        display: 'block',
        fontFamily: "'DM Mono', monospace",
        fontSize: '9px',
        letterSpacing: '2px',
        color: '#888',
        marginBottom: '8px',
        textTransform: 'uppercase'
      }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '14px 16px',
          background: '#2A2A2A',
          border: `1px solid ${value ? '#C8A45A' : '#333'}`,
          color: '#F5F1EA',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          outline: 'none',
          borderRadius: '2px'
        }}
      />
    </div>
  )
}

// ── Main Onboarding ───────────────────────────────────────────────────
export default function Onboarding() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  // Profile state
  const [age, setAge] = useState('')
  const [gender, setGender] = useState('')
  const [cityCurrente, setCityCurrent] = useState('')
  const [cityHome, setCityHome] = useState('')
  const [profession, setProfession] = useState('')
  const [industry, setIndustry] = useState('')
  const [company, setCompany] = useState('')
  const [interests, setInterests] = useState<string[]>([])
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('standard')

  const totalSteps = 5

  const toggleInterest = (interest: string) => {
    setInterests(prev =>
      prev.includes(interest)
        ? prev.filter(i => i !== interest)
        : [...prev, interest]
    )
  }

  const canProceed = () => {
    if (step === 0) return age && gender
    if (step === 1) return cityCurrente
    if (step === 2) return profession && industry
    if (step === 3) return interests.length >= 3
    if (step === 4) return mood && edition
    return true
  }

  const handleFinish = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    await supabase.from('profiles').update({
      age: parseInt(age),
      gender,
      city_current: cityCurrente,
      city_home: cityHome || cityCurrente,
      profession,
      industry,
      company,
      interests,
      mood_preference: mood,
      edition_preference: edition,
      onboarding_complete: true,
      updated_at: new Date().toISOString()
    }).eq('id', user.id)

    router.push('/home')
  }

  const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#1A1A1A',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px',
    paddingTop: '48px'
  }

  const headingStyle: React.CSSProperties = {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '26px',
    fontWeight: '700',
    color: '#F5F1EA',
    marginBottom: '8px',
    lineHeight: '1.2'
  }

  const subStyle: React.CSSProperties = {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    color: '#666',
    marginBottom: '32px',
    lineHeight: '1.5'
  }

  return (
    <div style={containerStyle}>
      <div style={{ maxWidth: '400px', width: '100%', margin: '0 auto', flex: 1 }}>

        {/* Progress */}
        <StepDots total={totalSteps} current={step} />

        {/* Step label */}
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '9px',
          letterSpacing: '2px',
          color: '#C8A45A',
          marginBottom: '16px'
        }}>
          STEP {step + 1} OF {totalSteps}
        </div>

        {/* ── STEP 0: About you ── */}
        {step === 0 && (
          <div className="animate-fade-up">
            <h2 style={headingStyle}>Tell us about yourself</h2>
            <p style={subStyle}>This shapes what news we prioritise for you.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <TextInput label="Age" value={age} onChange={setAge} placeholder="32" type="number" />
              <div>
                <label style={{
                  display: 'block',
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '9px',
                  letterSpacing: '2px',
                  color: '#888',
                  marginBottom: '12px',
                  textTransform: 'uppercase'
                }}>Gender</label>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {['Woman', 'Man', 'Non-binary', 'Prefer not to say'].map(g => (
                    <Chip key={g} label={g} selected={gender === g} onToggle={() => setGender(g)} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 1: Location ── */}
        {step === 1 && (
          <div className="animate-fade-up">
            <h2 style={headingStyle}>Where are you based?</h2>
            <p style={subStyle}>We cover local news for your current city. We also track your home city.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <SelectInput
                label="City you live in now"
                value={cityCurrente}
                onChange={setCityCurrent}
                options={CITIES}
              />
              <SelectInput
                label="Home city (where you're from)"
                value={cityHome}
                onChange={setCityHome}
                options={CITIES}
              />
            </div>
          </div>
        )}

        {/* ── STEP 2: Work ── */}
        {step === 2 && (
          <div className="animate-fade-up">
            <h2 style={headingStyle}>What do you do?</h2>
            <p style={subStyle}>We use this to make business and economy coverage more relevant to your world.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <TextInput
                label="Your role / profession"
                value={profession}
                onChange={setProfession}
                placeholder="e.g. Finance Manager"
              />
              <SelectInput
                label="Industry"
                value={industry}
                onChange={setIndustry}
                options={INDUSTRIES}
              />
              <TextInput
                label="Company (optional)"
                value={company}
                onChange={setCompany}
                placeholder="e.g. Amazon"
              />
            </div>
          </div>
        )}

        {/* ── STEP 3: Interests ── */}
        {step === 3 && (
          <div className="animate-fade-up">
            <h2 style={headingStyle}>What are you into?</h2>
            <p style={subStyle}>Pick at least 3. These shape the culture, sports, and lifestyle coverage in your brief.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {INTERESTS.map(interest => (
                <Chip
                  key={interest}
                  label={interest}
                  selected={interests.includes(interest)}
                  onToggle={() => toggleInterest(interest)}
                />
              ))}
            </div>
            {interests.length > 0 && (
              <div style={{
                marginTop: '16px',
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                color: '#C8A45A',
                letterSpacing: '1px'
              }}>
                {interests.length} selected {interests.length < 3 ? `— pick ${3 - interests.length} more` : '✓'}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 4: Preferences ── */}
        {step === 4 && (
          <div className="animate-fade-up">
            <h2 style={headingStyle}>How do you like your news?</h2>
            <p style={subStyle}>You can change these any time from your profile.</p>

            {/* Mood */}
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '2px',
              color: '#888',
              marginBottom: '12px',
              textTransform: 'uppercase'
            }}>Analysis tone</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '32px' }}>
              {MOODS.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMood(m.id)}
                  style={{
                    padding: '16px',
                    background: mood === m.id ? 'rgba(200,164,90,0.1)' : '#2A2A2A',
                    border: `1px solid ${mood === m.id ? '#C8A45A' : '#333'}`,
                    borderRadius: '2px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start',
                    minHeight: '44px'
                  }}
                >
                  <span style={{ fontSize: '18px', flexShrink: 0, color: '#C8A45A' }}>{m.icon}</span>
                  <div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '14px',
                      fontWeight: '600',
                      color: mood === m.id ? '#C8A45A' : '#F5F1EA',
                      marginBottom: '2px'
                    }}>{m.label}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '12px',
                      color: '#666',
                      lineHeight: '1.4'
                    }}>{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Edition */}
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '2px',
              color: '#888',
              marginBottom: '12px',
              textTransform: 'uppercase'
            }}>Default reading depth</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {EDITIONS.map(e => (
                <button
                  key={e.id}
                  onClick={() => setEdition(e.id)}
                  style={{
                    padding: '16px',
                    background: edition === e.id ? 'rgba(200,164,90,0.1)' : '#2A2A2A',
                    border: `1px solid ${edition === e.id ? '#C8A45A' : '#333'}`,
                    borderRadius: '2px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start',
                    minHeight: '44px'
                  }}
                >
                  <span style={{ fontSize: '18px', flexShrink: 0, color: '#C8A45A' }}>{e.icon}</span>
                  <div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '14px',
                      fontWeight: '600',
                      color: edition === e.id ? '#C8A45A' : '#F5F1EA',
                      marginBottom: '2px'
                    }}>{e.label}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '12px',
                      color: '#666',
                      lineHeight: '1.4'
                    }}>{e.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div style={{
          display: 'flex',
          gap: '12px',
          marginTop: '40px',
          paddingBottom: '40px'
        }}>
          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              style={{
                flex: '0 0 auto',
                padding: '16px 20px',
                background: 'transparent',
                color: '#666',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px',
                border: '1px solid #333',
                cursor: 'pointer',
                borderRadius: '2px',
                minHeight: '52px'
              }}
            >← Back</button>
          )}

          <button
            onClick={() => {
              if (step < totalSteps - 1) {
                setStep(s => s + 1)
              } else {
                handleFinish()
              }
            }}
            disabled={!canProceed() || saving}
            style={{
              flex: 1,
              padding: '16px',
              background: canProceed() && !saving ? '#C8A45A' : '#2A2A2A',
              color: canProceed() && !saving ? '#1A1A1A' : '#444',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              fontWeight: '600',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              border: 'none',
              cursor: canProceed() && !saving ? 'pointer' : 'not-allowed',
              borderRadius: '2px',
              minHeight: '52px',
              transition: 'all 0.2s'
            }}
          >
            {saving ? 'Saving...' :
              step === totalSteps - 1 ? 'Build My Brief →' : 'Continue →'}
          </button>
        </div>
      </div>
    </div>
  )
}
