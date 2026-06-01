// src/pages/onboarding.tsx
//
// Multi-step onboarding. Step 0: choose Standard vs Personalised.
// Personalised: steps 1-5 (about you → cities → work → interests → mood+edition).
// Standard path jumps from step 0 to step 6 (edition only).
//
// Sprint 8 changes:
// - Interests step pre-checks the four "common" interests (opt-out style).
// - Edition labels updated to "The Brief / The Daily / The Editorial".
// - Mood UI preserved but dormant in the new pipeline (Sprint 8 note in
//   MIGRATION.md).
// Internal edition IDs ('5min' / '10min' / 'deep') unchanged.

import { useState } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
}

const CITIES = [
  'Bengaluru', 'Delhi / NCR', 'Mumbai', 'Hyderabad', 'Chennai',
  'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow',
  'Chandigarh', 'Kochi', 'Indore', 'Bhopal', 'Nagpur',
  'Surat', 'Visakhapatnam', 'Coimbatore', 'Vadodara', 'Other',
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
  'Healthcare & Medicine', 'Teaching & Academia', 'Policy & Government', 'Other',
]

const INDUSTRIES = [
  'Technology', 'Finance & Banking', 'E-commerce & Retail',
  'Consulting', 'Healthcare & Pharma', 'Media & Entertainment',
  'Education', 'Government & Public Sector', 'Manufacturing',
  'Real Estate', 'Logistics & Supply Chain', 'Energy',
  'Legal Services', 'FMCG & Consumer Goods', 'Hospitality & Travel', 'Other',
]

const STUDY_AREAS = [
  'Engineering & Technology', 'Business & Management', 'Medicine & Healthcare',
  'Law', 'Arts & Humanities', 'Science', 'Commerce & Economics',
  'Design & Architecture', 'Social Sciences', 'Other',
]

const STUDY_LEVELS = [
  'School (Class 9–12)', 'Undergraduate', 'Postgraduate / MBA',
  'PhD / Research', 'Professional Course', 'Other',
]

// Interests are shown as a checklist. The first four are PRE-CHECKED by
// default so personalised readers get markets/business/tech/sport without
// having to ask for them — opt-out rather than opt-in.
const INTERESTS_DEFAULT_CHECKED = [
  'Business & Economy',
  'Markets & Investing',
  'Technology',
  'Sport',
]

const INTERESTS_ALL = [
  // Defaults first
  'Business & Economy', 'Markets & Investing', 'Technology', 'Sport',
  // Then the rest
  'World Affairs', 'Indian Politics',
  'Science', 'Artificial Intelligence',
  'Health & Wellness', 'Environment & Climate',
  'Culture & Arts', 'Books & Literature', 'Film & OTT', 'Music',
  'Food & Travel', 'Style & Design',
  'Startups & Entrepreneurship', 'Personal Finance',
  'Philosophy', 'History', 'Psychology', 'Education', 'Law & Policy',
  'Parenting', 'Sustainability', 'Gaming',
  'Space & Astronomy',
  'Cricket', 'Football', 'Formula 1',
]

const MOODS = [
  { id: 'neutral', label: 'Neutral', desc: 'Balanced, objective framing. Facts first.', icon: '◎' },
  { id: 'optimistic', label: 'Hopeful', desc: 'Same facts, forward-looking lens. What could go right.', icon: '◑' },
  { id: 'critical', label: 'Critical', desc: 'Sharper analysis. Questions assumptions.', icon: '◐' },
]

// Canonical edition IDs (unchanged in DB). Display names are new.
const EDITIONS = [
  { id: '5min',  label: 'The Brief',     desc: '5 minutes · headlines + why-it-matters, scannable on a commute', icon: '⚡' },
  { id: '10min', label: 'The Daily',     desc: '10 minutes · the full daily read with facts, context, and analysis', icon: '◆' },
  { id: 'deep',  label: 'The Editorial', desc: '15 minutes · patterns, a long read, and one number/chart/quote', icon: '◈' },
]

const FEATURES_STANDARD = [
  'Major events', 'World & India', 'Business & markets',
  'Three editions', 'No setup',
]

const FEATURES_PERSONALISED = [
  'Major events', 'World & India',
  'Your city', 'Your interests', 'Three editions', 'Reordered for you',
]

// ─── Shared styles ──────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '10px',
  letterSpacing: '2px', color: C.textMute, marginBottom: '10px',
  textTransform: 'uppercase' as const,
}

const headStyle: React.CSSProperties = {
  fontFamily: "'Playfair Display', Georgia, serif",
  fontSize: '26px', fontWeight: 700, color: C.text,
  marginBottom: '10px', lineHeight: '1.2',
}

const subStyle: React.CSSProperties = {
  fontFamily: "'DM Sans', sans-serif",
  fontSize: '14px', color: C.textMute,
  marginBottom: '28px', lineHeight: '1.6',
}

// ─── Tiny components ────────────────────────────────────────────────────────

function Chip({ label, selected, onToggle }: { label: string; selected: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} style={{
      padding: '10px 14px',
      background: selected ? C.gold : C.surface2,
      color: selected ? '#1A1A1A' : C.textSoft,
      fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
      fontWeight: selected ? 600 : 400,
      border: `1px solid ${selected ? C.gold : C.border}`,
      borderRadius: '3px', cursor: 'pointer',
      minHeight: '40px', whiteSpace: 'nowrap' as const,
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
        width: '100%', padding: '15px 16px',
        background: C.surface,
        border: `1px solid ${value ? C.gold : C.border}`,
        color: value ? C.text : C.textDim,
        fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
        outline: 'none', borderRadius: '3px',
        appearance: 'none' as const, cursor: 'pointer',
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
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{
        width: '100%', padding: '15px 16px',
        background: C.surface,
        border: `1px solid ${value ? C.gold : C.border}`,
        color: C.text, fontFamily: "'DM Sans', sans-serif",
        fontSize: '15px', outline: 'none', borderRadius: '3px',
      }} />
    </div>
  )
}

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginBottom: '32px' }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: i === current ? '22px' : '6px', height: '6px',
          borderRadius: '3px', background: i <= current ? C.gold : C.border,
          transition: 'all 0.3s ease',
        }} />
      ))}
    </div>
  )
}

function Wordmark({ size = 'large' }: { size?: 'large' | 'small' }) {
  const fs = size === 'large' ? 'clamp(32px, 9vw, 42px)' : 'clamp(24px, 7vw, 32px)'
  return (
    <div style={{ marginBottom: '22px' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif", fontSize: fs,
        fontWeight: 900, color: C.text, letterSpacing: '-0.5px',
        lineHeight: '1', marginBottom: '2px',
      }}>Morning</div>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif", fontSize: fs,
        fontWeight: 900, color: C.gold, letterSpacing: '-0.5px',
        lineHeight: '1',
      }}>Brief</div>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Onboarding() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  const [briefType, setBriefType] = useState<'standard' | 'personalised' | ''>('')
  const [age, setAge] = useState('')
  const [gender, setGender] = useState('')
  const [cityCurrent, setCityCurrent] = useState('')
  const [cityHome, setCityHome] = useState('')
  const [sameAsCurrentCity, setSameAsCurrentCity] = useState(false)
  const [extraCities, setExtraCities] = useState<string[]>(['', '', ''])
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
  // Interests start with the four defaults pre-checked. The user can untick
  // these and/or add others.
  const [interests, setInterests] = useState<string[]>([...INTERESTS_DEFAULT_CHECKED])
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('10min')

  const personalisedSteps = 5
  const isWorkingPro = ['early_career', 'mid_career', 'senior'].includes(lifeStage)

  const toggleInterest = (i: string) => {
    setInterests(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])
  }

  const updateExtraCity = (idx: number, val: string) => {
    const updated = [...extraCities]
    updated[idx] = val
    setExtraCities(updated)
  }

  const handleFinish = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }
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
      edition_preference: edition,                  // canonical: 5min / 10min / deep
      brief_type: briefType || 'standard',
      onboarding_complete: true,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id)
    window.location.href = '/home'
  }

  const next = () => {
    if (briefType === 'standard') { setStep(6) }
    else { setStep(s => s + 1) }
  }

  const back = () => setStep(s => s - 1)

  const containerStyle: React.CSSProperties = {
    minHeight: '100vh', background: C.bg,
    display: 'flex', flexDirection: 'column',
    padding: '32px 24px 24px',
  }

  const btnPrimary: React.CSSProperties = {
    flex: 1, padding: '17px',
    background: C.gold, color: '#1A1A1A',
    fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
    fontWeight: 700, letterSpacing: '1.5px',
    textTransform: 'uppercase', border: 'none',
    cursor: 'pointer', borderRadius: '3px', minHeight: '54px',
  }

  const btnSecondary: React.CSSProperties = {
    padding: '17px 22px', background: 'transparent',
    color: C.textMute, fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px', fontWeight: 500,
    border: `1px solid ${C.border}`, cursor: 'pointer',
    borderRadius: '3px', minHeight: '54px',
  }

  return (
    <div style={containerStyle}>
      <div style={{ maxWidth: '420px', width: '100%', margin: '0 auto', flex: 1 }}>

        {briefType && step > 0 && step !== 6 && <StepDots total={personalisedSteps} current={step - 1} />}

        {/* STEP 0 */}
        {step === 0 && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <Wordmark size="large" />
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                letterSpacing: '4px', color: C.gold,
                textTransform: 'uppercase',
              }}>WELCOME</div>
            </div>
            <h2 style={{ ...headStyle, textAlign: 'center', marginBottom: '8px' }}>Choose your brief</h2>
            <p style={{ ...subStyle, textAlign: 'center' }}>Tap a card to select. You can change this later.</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '28px' }}>
              {([
                { id: 'standard' as const, label: 'Standard', sub: 'No setup', features: FEATURES_STANDARD },
                { id: 'personalised' as const, label: 'Personalised', sub: 'Only 3 min setup', features: FEATURES_PERSONALISED },
              ]).map(col => (
                <div key={col.id} onClick={() => setBriefType(col.id)} style={{
                  background: briefType === col.id ? C.goldSoft : C.surface,
                  border: `1px solid ${briefType === col.id ? C.gold : C.border}`,
                  borderTop: `3px solid ${briefType === col.id ? C.gold : C.borderHi}`,
                  borderRadius: '4px', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column',
                }}>
                  <div style={{ padding: '16px 14px 12px' }}>
                    <div style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: '18px', fontWeight: 700,
                      color: briefType === col.id ? C.gold : C.text,
                      marginBottom: '4px',
                    }}>{col.label}</div>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px', color: C.textMute,
                    }}>{col.sub.toUpperCase()}</div>
                  </div>
                  <div style={{ height: '1px', background: briefType === col.id ? 'rgba(200,164,90,0.2)' : C.border }} />
                  <div style={{ padding: '12px 14px' }}>
                    {col.features.map(f => (
                      <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '4px 0' }}>
                        <span style={{ color: C.gold, fontSize: '11px', fontWeight: 700, marginTop: '2px', flexShrink: 0 }}>✓</span>
                        <span style={{
                          fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                          color: C.textSoft, lineHeight: '1.4',
                        }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {briefType && (
              <button type="button" onClick={next} disabled={saving} style={btnPrimary}>
                {saving ? 'Setting up...' : briefType === 'standard' ? 'Start Reading →' : 'Set Up My Profile →'}
              </button>
            )}
          </div>
        )}

        {/* STEP 1 — about you */}
        {step === 1 && briefType === 'personalised' && (
          <div>
            <Wordmark size="small" />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: C.gold, marginBottom: '14px' }}>STEP 1 OF {personalisedSteps}</div>
            <h2 style={headStyle}>A little about you</h2>
            <p style={subStyle}>All optional. Age and gender don't affect what news you see — we use them only for soft context.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div>
                <label style={labelStyle}>Age</label>
                <input type="number" value={age}
                  onChange={e => {
                    const raw = e.target.value
                    if (raw === '') { setAge(''); return }
                    const val = parseInt(raw)
                    if (!isNaN(val) && val >= 0) setAge(String(val))
                  }}
                  onBlur={() => { const val = parseInt(age); if (isNaN(val) || val < 12) setAge('') }}
                  placeholder="e.g. 28"
                  style={{
                    width: '100%', padding: '15px 16px',
                    background: C.surface,
                    border: `1px solid ${age ? C.gold : C.border}`,
                    color: C.text, fontFamily: "'DM Sans', sans-serif",
                    fontSize: '15px', outline: 'none', borderRadius: '3px',
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

        {/* STEP 2 — cities */}
        {step === 2 && briefType === 'personalised' && (
          <div>
            <Wordmark size="small" />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: C.gold, marginBottom: '14px' }}>STEP 2 OF {personalisedSteps}</div>
            <h2 style={headStyle}>Your cities</h2>
            <p style={subStyle}>We add a "Your city" section to your personalised brief.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <SelectInput label="City you live in now" value={cityCurrent} onChange={setCityCurrent} options={CITIES} placeholder="Select your city" />
              <div>
                <label style={labelStyle}>Home city (where you're from)</label>
                <button type="button"
                  onClick={() => { setSameAsCurrentCity(!sameAsCurrentCity); if (!sameAsCurrentCity) setCityHome('') }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    marginBottom: '12px', minHeight: '36px', padding: 0,
                  }}>
                  <div style={{
                    width: '20px', height: '20px',
                    border: `2px solid ${sameAsCurrentCity ? C.gold : C.borderHi}`,
                    borderRadius: '3px', flexShrink: 0,
                    background: sameAsCurrentCity ? C.gold : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {sameAsCurrentCity && <span style={{ color: '#1A1A1A', fontSize: '12px', fontWeight: 700 }}>✓</span>}
                  </div>
                  <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: C.textSoft }}>Same as current city</span>
                </button>
                {!sameAsCurrentCity && <SelectInput label="" value={cityHome} onChange={setCityHome} options={CITIES} placeholder="Select home city" />}
              </div>
              <div>
                <label style={labelStyle}>Other cities to cover (optional, up to 3)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {extraCities.map((city, idx) => (
                    <select key={idx} value={city} onChange={e => updateExtraCity(idx, e.target.value)} style={{
                      width: '100%', padding: '15px 16px',
                      background: C.surface,
                      border: `1px solid ${city ? C.gold : C.border}`,
                      color: city ? C.text : C.textDim,
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '14px', outline: 'none',
                      borderRadius: '3px', appearance: 'none' as const,
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

        {/* STEP 3 — work / study */}
        {step === 3 && briefType === 'personalised' && (
          <div>
            <Wordmark size="small" />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: C.gold, marginBottom: '14px' }}>STEP 3 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What do you do?</h2>
            <p style={subStyle}>Shapes story ordering and "for you" relevance.</p>
            <div style={{ marginBottom: '24px' }}>
              <label style={labelStyle}>Which best describes you?</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {LIFE_STAGES.map(ls => (
                  <button type="button" key={ls.id}
                    onClick={() => { setLifeStage(ls.id); setWorkArea(''); setIndustry(''); setCompany(''); setStudyArea(''); setStudyLevel('') }}
                    style={{
                      padding: '14px 12px', textAlign: 'center',
                      background: lifeStage === ls.id ? C.goldSoft : C.surface,
                      border: `1px solid ${lifeStage === ls.id ? C.gold : C.border}`,
                      borderRadius: '4px', cursor: 'pointer',
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'center', gap: '7px', minHeight: '76px',
                    }}>
                    <span style={{ fontSize: '22px' }}>{ls.icon}</span>
                    <span style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                      fontWeight: lifeStage === ls.id ? 600 : 400,
                      color: lifeStage === ls.id ? C.gold : C.textSoft,
                      lineHeight: '1.3',
                    }}>{ls.label}</span>
                  </button>
                ))}
              </div>
            </div>
            {(isWorkingPro || lifeStage === 'freelancer') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <SelectInput label="Area of work" value={workArea} onChange={setWorkArea} options={WORK_AREAS} />
                {workArea === 'Other' && <TextInput label="Please specify" value={workAreaOther} onChange={setWorkAreaOther} placeholder="Your area of work" />}
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                {industry === 'Other' && <TextInput label="Please specify" value={industryOther} onChange={setIndustryOther} placeholder="Your industry" />}
                {isWorkingPro && (
                  <TextInput label="Company name (optional)" value={company} onChange={setCompany} placeholder="e.g. Amazon" />
                )}
              </div>
            )}
            {lifeStage === 'business' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                {industry === 'Other' && <TextInput label="Please specify" value={industryOther} onChange={setIndustryOther} placeholder="Your industry" />}
                <TextInput label="Company / venture name (optional)" value={company} onChange={setCompany} placeholder="e.g. My Startup" />
              </div>
            )}
            {lifeStage === 'student' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <SelectInput label="Area of study" value={studyArea} onChange={setStudyArea} options={STUDY_AREAS} />
                {studyArea === 'Other' && <TextInput label="Please specify" value={studyAreaOther} onChange={setStudyAreaOther} placeholder="Your field of study" />}
                <SelectInput label="Level of education" value={studyLevel} onChange={setStudyLevel} options={STUDY_LEVELS} />
                {studyLevel === 'Other' && <TextInput label="Please specify" value={studyLevelOther} onChange={setStudyLevelOther} placeholder="Your level" />}
              </div>
            )}
          </div>
        )}

        {/* STEP 4 — interests */}
        {step === 4 && briefType === 'personalised' && (
          <div>
            <Wordmark size="small" />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: C.gold, marginBottom: '14px' }}>STEP 4 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What are you into?</h2>
            <p style={subStyle}>The four common ones are already ticked — untick what you don't want and add what you do.</p>

            <div style={{
              background: C.surface, border: `1px solid ${C.border}`,
              padding: '12px 14px', marginBottom: '20px',
              fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
              color: C.textMute, lineHeight: 1.6,
            }}>
              These topics become sections in your personalised brief. Untick
              if you don't want a topic — you'll skip it entirely.
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '24px' }}>
              {INTERESTS_ALL.map(item => (
                <Chip key={item} label={item} selected={interests.includes(item)} onToggle={() => toggleInterest(item)} />
              ))}
            </div>
            {interests.length > 0 && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: C.gold, letterSpacing: '1.5px', marginBottom: '8px',
              }}>{interests.length} SELECTED ✓</div>
            )}
          </div>
        )}

        {/* STEP 5 — mood + edition (personalised) */}
        {step === 5 && briefType === 'personalised' && (
          <div>
            <Wordmark size="small" />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: C.gold, marginBottom: '14px' }}>STEP 5 OF {personalisedSteps}</div>
            <h2 style={headStyle}>How do you like your news?</h2>
            <p style={subStyle}>You can change these any time from your profile.</p>

            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
              fontWeight: 600, color: C.textSoft, marginBottom: '12px',
              letterSpacing: '0.5px',
            }}>Analysis tone</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '32px' }}>
              {MOODS.map(m => (
                <button type="button" key={m.id} onClick={() => setMood(m.id)} style={{
                  padding: '16px',
                  background: mood === m.id ? C.goldSoft : C.surface,
                  border: `1px solid ${mood === m.id ? C.gold : C.border}`,
                  borderRadius: '3px', cursor: 'pointer',
                  textAlign: 'left', display: 'flex',
                  gap: '12px', alignItems: 'center', minHeight: '44px',
                }}>
                  <span style={{ fontSize: '20px', flexShrink: 0, color: C.gold, width: '24px', textAlign: 'center' }}>{m.icon}</span>
                  <div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                      fontWeight: 600, color: mood === m.id ? C.gold : C.text, marginBottom: '2px',
                    }}>{m.label}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                      color: C.textMute, lineHeight: '1.4',
                    }}>{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
              fontWeight: 600, color: C.textSoft, marginBottom: '12px',
              letterSpacing: '0.5px',
            }}>Default reading depth</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {EDITIONS.map(e => (
                <button type="button" key={e.id} onClick={() => setEdition(e.id)} style={{
                  padding: '16px',
                  background: edition === e.id ? C.goldSoft : C.surface,
                  border: `1px solid ${edition === e.id ? C.gold : C.border}`,
                  borderRadius: '3px', cursor: 'pointer',
                  textAlign: 'left', display: 'flex',
                  gap: '12px', alignItems: 'center', minHeight: '44px',
                }}>
                  <span style={{ fontSize: '20px', flexShrink: 0, color: C.gold, width: '24px', textAlign: 'center' }}>{e.icon}</span>
                  <div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                      fontWeight: 600, color: edition === e.id ? C.gold : C.text, marginBottom: '2px',
                    }}>{e.label}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                      color: C.textMute, lineHeight: '1.4',
                    }}>{e.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 6 — edition (standard path) */}
        {step === 6 && briefType === 'standard' && (
          <div>
            <Wordmark size="small" />
            <h2 style={headStyle}>How long is your morning?</h2>
            <p style={subStyle}>Pick your default reading depth. You can change this any time.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {EDITIONS.map(e => (
                <button type="button" key={e.id} onClick={() => setEdition(e.id)} style={{
                  padding: '16px',
                  background: edition === e.id ? C.goldSoft : C.surface,
                  border: `1px solid ${edition === e.id ? C.gold : C.border}`,
                  borderRadius: '3px', cursor: 'pointer',
                  textAlign: 'left', display: 'flex',
                  gap: '12px', alignItems: 'flex-start', minHeight: '44px',
                }}>
                  <span style={{ fontSize: '20px', flexShrink: 0, color: C.gold }}>{e.icon}</span>
                  <div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                      fontWeight: 600, color: edition === e.id ? C.gold : C.text, marginBottom: '2px',
                    }}>{e.label}</div>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                      color: C.textMute, lineHeight: '1.4',
                    }}>{e.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '40px', paddingBottom: '48px' }}>
          {step > 0 && (
            <button type="button" onClick={() => step === 6 ? setStep(0) : back()} style={btnSecondary}>← Back</button>
          )}
          {step > 0 && (
            <button type="button"
              onClick={() => {
                if (step === 6) { handleFinish() }
                else if (step < personalisedSteps) { setStep(s => s + 1) }
                else { handleFinish() }
              }}
              disabled={saving}
              style={btnPrimary}>
              {saving ? 'Saving...' : (step === personalisedSteps || step === 6) ? 'Build My Brief →' : 'Continue →'}
            </button>
          )}
        </div>

      </div>
    </div>
  )
}
