import { useState } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'

// ── Constants ──────────────────────────────────────────────────────────────

const CITIES = [
  'Bengaluru', 'Delhi / NCR', 'Mumbai', 'Hyderabad', 'Chennai',
  'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow',
  'Chandigarh', 'Kochi', 'Indore', 'Bhopal', 'Nagpur',
  'Surat', 'Visakhapatnam', 'Coimbatore', 'Vadodara', 'Other'
]

const LIFE_STAGES = [
  { id: 'student', label: 'Student', icon: '🎓' },
  { id: 'early_career', label: 'Early Career (0–5 yrs)', icon: '🌱' },
  { id: 'mid_career', label: 'Mid Career (5–15 yrs)', icon: '💼' },
  { id: 'senior', label: 'Senior Professional (15+ yrs)', icon: '⭐' },
  { id: 'business', label: 'Business Owner', icon: '🏢' },
  { id: 'freelancer', label: 'Freelancer / Consultant', icon: '🔧' },
  { id: 'homemaker', label: 'Homemaker', icon: '🏠' },
  { id: 'retired', label: 'Retired', icon: '☀️' },
  { id: 'prefer_not', label: 'Prefer not to say', icon: '◎' },
]

const WORK_AREAS = [
  'Finance & Accounting', 'Technology & Engineering', 'Marketing & Communications',
  'Sales & Business Development', 'Operations & Supply Chain', 'Human Resources',
  'Legal & Compliance', 'Design & Creative', 'Research & Analytics',
  'Healthcare & Medicine', 'Teaching & Academia', 'Policy & Government', 'Other'
]

const INDUSTRIES = [
  'Technology', 'Finance & Banking', 'E-commerce & Retail',
  'Consulting', 'Healthcare & Pharma', 'Media & Entertainment',
  'Education', 'Government & Public Sector', 'Manufacturing',
  'Real Estate', 'Logistics & Supply Chain', 'Energy',
  'Legal Services', 'FMCG & Consumer Goods', 'Hospitality & Travel', 'Other'
]

const STUDY_AREAS = [
  'Engineering & Technology', 'Business & Management', 'Medicine & Healthcare',
  'Law', 'Arts & Humanities', 'Science', 'Commerce & Economics',
  'Design & Architecture', 'Social Sciences', 'Other'
]

const STUDY_LEVELS = [
  'School (Class 9–12)', 'Undergraduate', 'Postgraduate / MBA',
  'PhD / Research', 'Professional Course', 'Other'
]

const INTERESTS = [
  'World Affairs', 'Indian Politics', 'Business & Economy',
  'Markets & Investing', 'Technology', 'Science',
  'Health & Wellness', 'Environment & Climate', 'Culture & Arts',
  'Books & Literature', 'Film & OTT', 'Music',
  'Sport', 'Food & Travel', 'Style & Design',
  'Startups & Entrepreneurship', 'Personal Finance', 'Philosophy',
  'History', 'Psychology', 'Education', 'Law & Policy',
  'Parenting', 'Sustainability', 'Gaming',
  'Artificial Intelligence', 'Space & Astronomy', 'Cricket',
  'Football', 'Formula 1'
]

// ── Shared UI ──────────────────────────────────────────────────────────────

const labelStyle = {
  display: 'block' as const,
  fontFamily: "'DM Mono', monospace",
  fontSize: '9px', letterSpacing: '2px',
  color: '#888', marginBottom: '10px',
  textTransform: 'uppercase' as const
}

function Chip({ label, selected, onToggle }: { label: string; selected: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={{
      padding: '9px 14px',
      background: selected ? '#C8A45A' : '#2A2A2A',
      color: selected ? '#1A1A1A' : '#999',
      fontFamily: "'DM Sans', sans-serif",
      fontSize: '13px', fontWeight: selected ? '600' : '400',
      border: `1px solid ${selected ? '#C8A45A' : '#333'}`,
      borderRadius: '2px', cursor: 'pointer',
      transition: 'all 0.15s', minHeight: '38px', whiteSpace: 'nowrap' as const
    }}>{label}</button>
  )
}

function SelectInput({ label, value, onChange, options, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; options: string[]; placeholder?: string
}) {
  return (
    <div>
      {label && <label style={labelStyle}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        width: '100%', padding: '14px 16px',
        background: '#2A2A2A',
        border: `1px solid ${value ? '#C8A45A' : '#333'}`,
        color: value ? '#F5F1EA' : '#555',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '15px', outline: 'none',
        borderRadius: '2px', appearance: 'none' as const, cursor: 'pointer'
      }}>
        <option value="">{placeholder || 'Select...'}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function TextInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      {label && <label style={labelStyle}>{label}</label>}
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} style={{
          width: '100%', padding: '14px 16px',
          background: '#2A2A2A',
          border: `1px solid ${value ? '#C8A45A' : '#333'}`,
          color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px', outline: 'none', borderRadius: '2px'
        }} />
    </div>
  )
}

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginBottom: '28px' }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: i === current ? '20px' : '6px', height: '6px',
          borderRadius: '3px',
          background: i <= current ? '#C8A45A' : '#2A2A2A',
          transition: 'all 0.3s ease'
        }} />
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Onboarding() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  // Step 0 — Brief type
  const [briefType, setBriefType] = useState<'standard' | 'personalised' | ''>('')

  // Step 1 — About you
  const [age, setAge] = useState('')
  const [gender, setGender] = useState('')

  // Step 2 — Cities
  const [cityCurrent, setCityCurrent] = useState('')
  const [cityHome, setCityHome] = useState('')
  const [sameAsCurrentCity, setSameAsCurrentCity] = useState(false)
  const [extraCities, setExtraCities] = useState<string[]>(['', '', ''])

  // Step 3 — Life stage & work
  const [lifeStage, setLifeStage] = useState('')
  const [workArea, setWorkArea] = useState('')
  const [workAreaOther, setWorkAreaOther] = useState('')
  const [industry, setIndustry] = useState('')
  const [industryOther, setIndustryOther] = useState('')
  const [company, setCompany] = useState('')
  const [studyArea, setStudyArea] = useState('')
  const [studyAreaOther, setStudyAreaOther] = useState('')
  const [studyLevel, setStudyLevel] = useState('')
  const [studyLevelOther, setStudyLevelOther] = useState('')

  // Step 4 — Interests
  const [interests, setInterests] = useState<string[]>([])

  // Step 5 — Preferences
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('standard')

  const personalisedSteps = 5

  const toggleInterest = (i: string) => {
    setInterests(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])
  }

  const updateExtraCity = (idx: number, val: string) => {
    const updated = [...extraCities]
    updated[idx] = val
    setExtraCities(updated)
  }

  const isWorkingPro = ['early_career', 'mid_career', 'senior'].includes(lifeStage)

  const handleFinish = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    await supabase.from('profiles').update({
      age: age ? parseInt(age) : null,
      gender: gender || null,
      city_current: cityCurrent || null,
      city_home: sameAsCurrentCity ? cityCurrent : (cityHome || null),
      extra_cities: extraCities.filter(Boolean),
      life_stage: lifeStage || null,
      work_area: workArea === 'Other' ? workAreaOther : (workArea || null),
      industry: industry === 'Other' ? industryOther : (industry || null),
      company: company || null,
      study_area: studyArea === 'Other' ? studyAreaOther : (studyArea || null),
      study_level: studyLevel === 'Other' ? studyLevelOther : (studyLevel || null),
      interests,
      mood_preference: mood,
      edition_preference: edition,
      brief_type: briefType || 'standard',
      onboarding_complete: true,
      updated_at: new Date().toISOString()
    }).eq('id', user.id)

    router.push('/home')
  }

  const next = () => {
    if (briefType === 'standard') {
      handleFinish()
    } else {
      setStep(s => s + 1)
    }
  }

  const back = () => setStep(s => s - 1)

  const containerStyle: React.CSSProperties = {
    minHeight: '100vh', background: '#1A1A1A',
    display: 'flex', flexDirection: 'column',
    padding: '24px', paddingTop: '40px'
  }

  const headStyle: React.CSSProperties = {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '24px', fontWeight: '700',
    color: '#F5F1EA', marginBottom: '8px', lineHeight: '1.2'
  }

  const subStyle: React.CSSProperties = {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '13px', color: '#555',
    marginBottom: '28px', lineHeight: '1.6'
  }

  const btnPrimary: React.CSSProperties = {
    flex: 1, padding: '16px',
    background: '#C8A45A',
    color: '#1A1A1A',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px', fontWeight: '600',
    letterSpacing: '1px', textTransform: 'uppercase',
    border: 'none', cursor: 'pointer',
    borderRadius: '2px', minHeight: '52px', transition: 'all 0.2s'
  }

  return (
    <div style={containerStyle}>
      <div style={{ maxWidth: '400px', width: '100%', margin: '0 auto', flex: 1 }}>

        {briefType && step > 0 && (
          <StepDots total={personalisedSteps} current={step - 1} />
        )}

        {/* ── STEP 0: Brief type ── */}
        {step === 0 && (
          <div>
            {/* Wordmark */}
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
                color: '#F5F1EA', letterSpacing: '-0.5px',
                lineHeight: '1', marginBottom: '4px'
              }}>Morning</div>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
                fontStyle: 'italic', color: '#C8A45A',
                letterSpacing: '-0.5px', lineHeight: '1',
                marginBottom: '20px'
              }}>Brief</div>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                letterSpacing: '4px', color: '#C8A45A',
                textTransform: 'uppercase'
              }}>WELCOME</div>
            </div>

            <h2 style={{ ...headStyle, textAlign: 'center', marginBottom: '6px' }}>
              How would you like your brief?
            </h2>
            <p style={{ ...subStyle, textAlign: 'center' }}>You can always change this later.</p>

            {/* Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '32px' }}>

              {/* Standard card */}
              <button onClick={() => setBriefType('standard')} style={{
                padding: '0',
                background: briefType === 'standard' ? 'rgba(200,164,90,0.06)' : '#1E1E1E',
                border: `2px solid ${briefType === 'standard' ? '#C8A45A' : '#2A2A2A'}`,
                borderRadius: '4px', cursor: 'pointer', textAlign: 'left',
                overflow: 'hidden'
              }}>
                {/* Card header */}
                <div style={{
                  padding: '16px 20px 12px',
                  borderBottom: `1px solid ${briefType === 'standard' ? 'rgba(200,164,90,0.2)' : '#242424'}`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '18px', fontWeight: '700',
                      color: briefType === 'standard' ? '#C8A45A' : '#F5F1EA'
                    }}>Standard Brief</div>
                    <div style={{
                      width: '20px', height: '20px', borderRadius: '50%',
                      border: `2px solid ${briefType === 'standard' ? '#C8A45A' : '#444'}`,
                      background: briefType === 'standard' ? '#C8A45A' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      {briefType === 'standard' && (
                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#1A1A1A' }} />
                      )}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px', color: '#666', lineHeight: '1.5'
                  }}>Top stories from India and the world. No setup needed.</div>
                </div>
                {/* Card bullets */}
                <div style={{ padding: '12px 20px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {['Top 5 world stories', 'Top 3 India stories', 'Markets snapshot', 'Sport & culture'].map(c => (
                    <div key={c} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ color: '#C8A45A', fontSize: '10px', flexShrink: 0 }}>◆</span>
                      <span style={{
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: '13px', color: briefType === 'standard' ? '#B0A898' : '#555'
                      }}>{c}</span>
                    </div>
                  ))}
                </div>
              </button>

              {/* Personalised card */}
              <button onClick={() => setBriefType('personalised')} style={{
                padding: '0',
                background: briefType === 'personalised' ? 'rgba(200,164,90,0.06)' : '#1E1E1E',
                border: `2px solid ${briefType === 'personalised' ? '#C8A45A' : '#2A2A2A'}`,
                borderRadius: '4px', cursor: 'pointer', textAlign: 'left',
                overflow: 'hidden'
              }}>
                {/* Card header */}
                <div style={{
                  padding: '16px 20px 12px',
                  borderBottom: `1px solid ${briefType === 'personalised' ? 'rgba(200,164,90,0.2)' : '#242424'}`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '18px', fontWeight: '700',
                      color: briefType === 'personalised' ? '#C8A45A' : '#F5F1EA'
                    }}>Personalised Brief</div>
                    <div style={{
                      width: '20px', height: '20px', borderRadius: '50%',
                      border: `2px solid ${briefType === 'personalised' ? '#C8A45A' : '#444'}`,
                      background: briefType === 'personalised' ? '#C8A45A' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      {briefType === 'personalised' && (
                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#1A1A1A' }} />
                      )}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px', color: '#666', lineHeight: '1.5'
                  }}>Tailored to your city, profession, and interests. Takes 3 minutes.</div>
                </div>
                {/* Card bullets */}
                <div style={{ padding: '12px 20px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {["Your city's local news", 'Industry-specific business', 'Topics you care about', 'Tone you prefer'].map(c => (
                    <div key={c} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ color: '#C8A45A', fontSize: '10px', flexShrink: 0 }}>◆</span>
                      <span style={{
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: '13px', color: briefType === 'personalised' ? '#B0A898' : '#555'
                      }}>{c}</span>
                    </div>
                  ))}
                </div>
              </button>
            </div>

            {/* Single CTA — only appears after selection */}
            {briefType && (
              <button
                onClick={next}
                disabled={saving}
                style={btnPrimary}
              >
                {saving ? 'Setting up...' :
                  briefType === 'standard' ? 'Start Reading →' : 'Set Up My Profile →'}
              </button>
            )}
          </div>
        )}

        {/* ── STEP 1: About you ── */}
        {step === 1 && briefType === 'personalised' && (
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              color: '#F5F1EA', letterSpacing: '-0.5px',
              lineHeight: '1', marginBottom: '2px'
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              fontStyle: 'italic', color: '#C8A45A',
              letterSpacing: '-0.5px', lineHeight: '1',
              marginBottom: '20px'
            }}>Brief</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '12px' }}>STEP 1 OF {personalisedSteps}</div>
            <h2 style={headStyle}>A little about you</h2>
            <p style={subStyle}>All optional — helps us frame stories for your perspective.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div>
                <label style={labelStyle}>Age</label>
                <input
                  type="number" value={age}
                  onChange={e => {
                    const val = parseInt(e.target.value)
                    if (e.target.value === '') { setAge(''); return }
                    if (val >= 12) setAge(e.target.value)
                  }}
                  min={12} placeholder="e.g. 28"
                  style={{
                    width: '100%', padding: '14px 16px', background: '#2A2A2A',
                    border: `1px solid ${age ? '#C8A45A' : '#333'}`,
                    color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif",
                    fontSize: '15px', outline: 'none', borderRadius: '2px'
                  }} />
              </div>
              <div>
                <label style={labelStyle}>Gender</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {['Woman', 'Man', 'Non-binary', 'Prefer not to say'].map(g => (
                    <Chip key={g} label={g} selected={gender === g} onToggle={() => setGender(g === gender ? '' : g)} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 2: Cities ── */}
        {step === 2 && briefType === 'personalised' && (
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              color: '#F5F1EA', lineHeight: '1', marginBottom: '2px'
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              fontStyle: 'italic', color: '#C8A45A', lineHeight: '1', marginBottom: '20px'
            }}>Brief</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '12px' }}>STEP 2 OF {personalisedSteps}</div>
            <h2 style={headStyle}>Your cities</h2>
            <p style={subStyle}>We cover local news for every city you add.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <SelectInput label="City you live in now" value={cityCurrent}
                onChange={setCityCurrent} options={CITIES} placeholder="Select your city" />

              <div>
                <label style={labelStyle}>Home city (where you're from)</label>
                <button
                  onClick={() => { setSameAsCurrentCity(!sameAsCurrentCity); if (!sameAsCurrentCity) setCityHome('') }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    marginBottom: '10px', minHeight: '32px', padding: '0'
                  }}>
                  <div style={{
                    width: '18px', height: '18px',
                    border: `2px solid ${sameAsCurrentCity ? '#C8A45A' : '#444'}`,
                    borderRadius: '2px', flexShrink: 0,
                    background: sameAsCurrentCity ? '#C8A45A' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {sameAsCurrentCity && <span style={{ color: '#1A1A1A', fontSize: '11px', fontWeight: '700' }}>✓</span>}
                  </div>
                  <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#888' }}>
                    Same as current city
                  </span>
                </button>
                {!sameAsCurrentCity && (
                  <SelectInput label="" value={cityHome}
                    onChange={setCityHome} options={CITIES} placeholder="Select home city" />
                )}
              </div>

              <div>
                <label style={labelStyle}>Other cities to cover (optional, up to 3)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {extraCities.map((city, idx) => (
                    <select key={idx} value={city} onChange={e => updateExtraCity(idx, e.target.value)} style={{
                      width: '100%', padding: '14px 16px', background: '#2A2A2A',
                      border: `1px solid ${city ? '#C8A45A' : '#2A2A2A'}`,
                      color: city ? '#F5F1EA' : '#444',
                      fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                      outline: 'none', borderRadius: '2px', appearance: 'none' as const
                    }}>
                      <option value="">+ Add city {idx + 1}</option>
                      {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 3: Life stage & work ── */}
        {step === 3 && briefType === 'personalised' && (
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              color: '#F5F1EA', lineHeight: '1', marginBottom: '2px'
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              fontStyle: 'italic', color: '#C8A45A', lineHeight: '1', marginBottom: '20px'
            }}>Brief</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '12px' }}>STEP 3 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What do you do?</h2>
            <p style={subStyle}>Shapes how we cover business and economy news.</p>

            {/* Life stage tiles */}
            <div style={{ marginBottom: '24px' }}>
              <label style={labelStyle}>Which best describes you?</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {LIFE_STAGES.map(ls => (
                  <button key={ls.id} onClick={() => { setLifeStage(ls.id); setWorkArea(''); setIndustry(''); setCompany(''); setStudyArea(''); setStudyLevel('') }} style={{
                    padding: '14px 12px', textAlign: 'center',
                    background: lifeStage === ls.id ? 'rgba(200,164,90,0.1)' : '#1E1E1E',
                    border: `1px solid ${lifeStage === ls.id ? '#C8A45A' : '#2A2A2A'}`,
                    borderRadius: '4px', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: '6px', minHeight: '72px'
                  }}>
                    <span style={{ fontSize: '22px' }}>{ls.icon}</span>
                    <span style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                      fontWeight: lifeStage === ls.id ? '600' : '400',
                      color: lifeStage === ls.id ? '#C8A45A' : '#999',
                      lineHeight: '1.3'
                    }}>{ls.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Adaptive follow-up fields */}
            {isWorkingPro && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Area of work" value={workArea} onChange={setWorkArea} options={WORK_AREAS} />
                {workArea === 'Other' && (
                  <TextInput label="Please specify" value={workAreaOther} onChange={setWorkAreaOther} placeholder="Your area of work" />
                )}
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                {industry === 'Other' && (
                  <TextInput label="Please specify" value={industryOther} onChange={setIndustryOther} placeholder="Your industry" />
                )}
                <TextInput label="Company name (optional)" value={company} onChange={setCompany} placeholder="e.g. Amazon" />
              </div>
            )}

            {lifeStage === 'freelancer' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Area of work" value={workArea} onChange={setWorkArea} options={WORK_AREAS} />
                {workArea === 'Other' && (
                  <TextInput label="Please specify" value={workAreaOther} onChange={setWorkAreaOther} placeholder="Your area of work" />
                )}
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                {industry === 'Other' && (
                  <TextInput label="Please specify" value={industryOther} onChange={setIndustryOther} placeholder="Your industry" />
                )}
              </div>
            )}

            {lifeStage === 'business' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                {industry === 'Other' && (
                  <TextInput label="Please specify" value={industryOther} onChange={setIndustryOther} placeholder="Your industry" />
                )}
                <TextInput label="Company / venture name (optional)" value={company} onChange={setCompany} placeholder="e.g. My Startup" />
              </div>
            )}

            {lifeStage === 'student' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Area of study" value={studyArea} onChange={setStudyArea} options={STUDY_AREAS} />
                {studyArea === 'Other' && (
                  <TextInput label="Please specify" value={studyAreaOther} onChange={setStudyAreaOther} placeholder="Your field of study" />
                )}
                <SelectInput label="Level of education" value={studyLevel} onChange={setStudyLevel} options={STUDY_LEVELS} />
                {studyLevel === 'Other' && (
                  <TextInput label="Please specify" value={studyLevelOther} onChange={setStudyLevelOther} placeholder="Your level" />
                )}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 4: Interests ── */}
        {step === 4 && briefType === 'personalised' && (
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              color: '#F5F1EA', lineHeight: '1', marginBottom: '2px'
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              fontStyle: 'italic', color: '#C8A45A', lineHeight: '1', marginBottom: '20px'
            }}>Brief</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '12px' }}>STEP 4 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What are you into?</h2>
            <p style={subStyle}>Pick as many as you like.</p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '24px' }}>
              {INTERESTS.map(item => (
                <Chip key={item} label={item}
                  selected={interests.includes(item)}
                  onToggle={() => toggleInterest(item)} />
              ))}
            </div>

            {interests.length > 0 && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                color: '#C8A45A', letterSpacing: '1px',
                marginBottom: '8px'
              }}>
                {interests.length} selected ✓
              </div>
            )}
          </div>
        )}

        {/* ── STEP 5: Preferences ── */}
        {step === 5 && briefType === 'personalised' && (
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              color: '#F5F1EA', lineHeight: '1', marginBottom: '2px'
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: 'clamp(22px, 6vw, 30px)', fontWeight: '900',
              fontStyle: 'italic', color: '#C8A45A', lineHeight: '1', marginBottom: '20px'
            }}>Brief</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '12px' }}>STEP 5 OF {personalisedSteps}</div>
            <h2 style={headStyle}>How do you like your news?</h2>
            <p style={subStyle}>Change these any time from your profile.</p>

            <div style={{ marginBottom: '28px' }}>
              <label style={labelStyle}>Analysis tone</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[
                  { id: 'neutral', label: 'Neutral', desc: 'Balanced and objective. Facts first.' },
                  { id: 'optimistic', label: 'Optimistic', desc: 'Same facts, forward-looking framing. What could go right.' },
                  { id: 'critical', label: 'Critical', desc: 'Sharper analysis. Questions assumptions.' },
                ].map(m => (
                  <button key={m.id} onClick={() => setMood(m.id)} style={{
                    padding: '14px 16px', textAlign: 'left',
                    background: mood === m.id ? 'rgba(200,164,90,0.08)' : '#1E1E1E',
                    border: `1px solid ${mood === m.id ? '#C8A45A' : '#2A2A2A'}`,
                    borderRadius: '2px', cursor: 'pointer', minHeight: '44px'
                  }}>
                    <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '14px', fontWeight: '600', color: mood === m.id ? '#C8A45A' : '#F5F1EA', marginBottom: '2px' }}>{m.label}</div>
                    <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '12px', color: '#555', lineHeight: '1.4' }}>{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={labelStyle}>Default reading depth</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[
                  { id: 'ultra', label: '5 Min', desc: 'Quick scan' },
                  { id: 'standard', label: '10 Min', desc: 'Full brief' },
                  { id: 'deep', label: 'Deep Dive', desc: 'Analysis' },
                ].map(e => (
                  <button key={e.id} onClick={() => setEdition(e.id)} style={{
                    flex: 1, padding: '14px 8px',
                    background: edition === e.id ? 'rgba(200,164,90,0.08)' : '#1E1E1E',
                    border: `1px solid ${edition === e.id ? '#C8A45A' : '#2A2A2A'}`,
                    borderRadius: '2px', cursor: 'pointer', minHeight: '60px'
                  }}>
                    <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', fontWeight: '600', color: edition === e.id ? '#C8A45A' : '#F5F1EA', marginBottom: '4px' }}>{e.label}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', color: '#555', letterSpacing: '0.5px' }}>{e.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Navigation ── */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '36px', paddingBottom: '48px' }}>
          {step > 0 && (
            <button onClick={back} style={{
              padding: '16px 20px', background: 'transparent',
              color: '#555', fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px', border: '1px solid #2A2A2A',
              cursor: 'pointer', borderRadius: '2px', minHeight: '52px'
            }}>← Back</button>
          )}

          {step > 0 && (
            <button
              onClick={() => {
                if (step < personalisedSteps) { setStep(s => s + 1) }
                else { handleFinish() }
              }}
              disabled={saving}
              style={btnPrimary}
            >
              {saving ? 'Saving...' : step === personalisedSteps ? 'Build My Brief →' : 'Continue →'}
            </button>
          )}
        </div>

      </div>
    </div>
  )
}