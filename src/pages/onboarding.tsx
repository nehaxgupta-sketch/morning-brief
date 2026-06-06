// src/pages/onboarding.tsx
//
// Multi-step onboarding. Step 0: choose Standard vs Personalised.
// Personalised: steps 1-4 (about you → cities → work → interests).
// Standard: step 0 then finish — no further steps.
//
// Sprint 9 changes:
// - Pre-populates ALL state from existing profile on mount so editing is non-destructive
// - Removed mood (analysis tone) step entirely
// - Removed default-edition step entirely
// - Standard path no longer has an edition step — picks brief_type then finishes
// - Backfills full_name from auth metadata if missing on the profile row

import { useEffect, useState } from 'react'
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

const INTERESTS_DEFAULT_CHECKED = [
  'Business & Economy',
  'Markets & Investing',
  'Technology',
  'Sport',
]

const INTERESTS_ALL = [
  'Business & Economy', 'Markets & Investing', 'Technology', 'Sport',
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

// ─── Helpers for loading "Other" fields ──────────────────────────────────────

// If the saved value is in the canonical options list, set the main value.
// If it's a free-text "Other" value, set main to 'Other' and the Other field
// to the saved string. If null/empty, clear both.
function setWithOther(
  saved: string | null | undefined,
  options: string[],
  setMain: (s: string) => void,
  setOther: (s: string) => void,
) {
  if (!saved) { setMain(''); setOther(''); return }
  if (options.includes(saved)) { setMain(saved); setOther('') }
  else { setMain('Other'); setOther(saved) }
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Onboarding() {
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

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
  const [interests, setInterests] = useState<string[]>([...INTERESTS_DEFAULT_CHECKED])

  const personalisedSteps = 4
  const isWorkingPro = ['early_career', 'mid_career', 'senior'].includes(lifeStage)

  // ─── Pre-populate from existing profile (the fix for "starts from scratch") ─
  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }

      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (!data) { setLoading(false); return }

      // Backfill full_name from auth metadata if profile row is missing it.
      // Fixes the case where the verification trigger overwrote signup's upsert.
      const metaName = (user.user_metadata as any)?.full_name as string | undefined
      if (!data.full_name && metaName) {
        await supabase.from('profiles').update({ full_name: metaName }).eq('id', user.id)
      }

      // brief_type — only pre-select if it's a valid value
      if (data.brief_type === 'standard' || data.brief_type === 'personalised') {
        setBriefType(data.brief_type)
      }

      if (data.age != null) setAge(String(data.age))
      if (data.gender) setGender(data.gender)
      if (data.city_current) setCityCurrent(data.city_current)
      if (data.city_home) {
        setCityHome(data.city_home)
        if (data.city_current && data.city_home === data.city_current) {
          setSameAsCurrentCity(true)
        }
      }
      if (Array.isArray(data.extra_cities)) {
        const padded = [...data.extra_cities, '', '', ''].slice(0, 3)
        setExtraCities(padded)
      }
      if (data.life_stage) setLifeStage(data.life_stage)
      setWithOther(data.work_area, WORK_AREAS, setWorkArea, setWorkAreaOther)
      setWithOther(data.industry, INDUSTRIES, setIndustry, setIndustryOther)
      if (data.company) setCompany(data.company)
      setWithOther(data.study_area, STUDY_AREAS, setStudyArea, setStudyAreaOther)
      setWithOther(data.study_level, STUDY_LEVELS, setStudyLevel, setStudyLevelOther)
      if (Array.isArray(data.interests) && data.interests.length > 0) {
        setInterests(data.interests)
      }

      setLoading(false)
    }
    load()
  }, [])

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

    const { error } = await supabase.from('profiles').update({
      age: age ? parseInt(age) : null,
      gender: gender || null,
      city_current: cityCurrent || null,
      city_home: sameAsCurrentCity ? cityCurrent : (cityHome || null),
      extra_cities: extraCities.filter(Boolean),
      life_stage: lifeStage || null,
      work_area: workArea === 'Other' ? (workAreaOther || null) : (workArea || null),
      industry: industry === 'Other' ? (industryOther || null) : (industry || null),
      company: company || null,
      study_area: studyArea === 'Other' ? (studyAreaOther || null) : (studyArea || null),
      study_level: studyLevel === 'Other' ? (studyLevelOther || null) : (studyLevel || null),
      interests,
      brief_type: briefType || 'standard',
      onboarding_complete: true,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id)

    if (error) {
      console.error('Onboarding save failed:', error)
      setSaving(false)
      alert('Save failed. Please try again.')
      return
    }
    window.location.href = '/home'
  }

  // Standard path: finish immediately after step 0. Personalised: go to step 1.
  const advanceFromStep0 = () => {
    if (briefType === 'standard') { handleFinish() }
    else if (briefType === 'personalised') { setStep(1) }
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

  if (loading) return null

  const isLastPersonalisedStep = step === personalisedSteps

  return (
    <div style={containerStyle}>
      <div style={{ maxWidth: '420px', width: '100%', margin: '0 auto', flex: 1 }}>

        {briefType === 'personalised' && step > 0 && (
          <StepDots total={personalisedSteps} current={step - 1} />
        )}

        {/* STEP 0 — choose brief type */}
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
              <button type="button" onClick={advanceFromStep0} disabled={saving} style={btnPrimary}>
                {saving ? 'Saving...' : briefType === 'standard' ? 'Start Reading →' : 'Set Up My Profile →'}
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

        {/* STEP 4 — interests (final personalised step) */}
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

        {/* Navigation */}
        {step > 0 && briefType === 'personalised' && (
          <div style={{ display: 'flex', gap: '12px', marginTop: '40px', paddingBottom: '48px' }}>
            <button type="button" onClick={back} style={btnSecondary}>← Back</button>
            <button type="button"
              onClick={() => {
                if (isLastPersonalisedStep) { handleFinish() }
                else { setStep(s => s + 1) }
              }}
              disabled={saving}
              style={btnPrimary}>
              {saving ? 'Saving...' : isLastPersonalisedStep ? 'Build My Brief →' : 'Continue →'}
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
