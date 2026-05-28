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
  { id: 'professional', label: 'Working Professional', icon: '💼' },
  { id: 'student', label: 'Student', icon: '🎓' },
  { id: 'business', label: 'Business Owner / Entrepreneur', icon: '🏢' },
  { id: 'homemaker', label: 'Homemaker', icon: '🏠' },
  { id: 'freelancer', label: 'Freelancer / Consultant', icon: '🔧' },
  { id: 'retired', label: 'Retired', icon: '☀️' },
  { id: 'between', label: 'Between Jobs', icon: '🔄' },
  { id: 'other', label: 'Other', icon: '◎' },
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

const INTERESTS = {
  'Arts & Culture': [
    'Books & Literature', 'Cinema & Films', 'Theatre & Live Performances',
    'Music — Bollywood', 'Music — Classical Indian', 'Music — Western Pop/Rock',
    'Music — Jazz & Blues', 'Music — Electronic', 'Visual Art & Painting',
    'Photography', 'Poetry & Creative Writing', 'Architecture & Design',
    'Stand-up Comedy', 'Podcasts'
  ],
  'Food & Drink': [
    'Cooking & Recipes', 'Restaurant Dining', 'Street Food',
    'Baking & Desserts', 'Wine & Spirits', 'Coffee Culture',
    'Nutrition & Healthy Eating', 'Veganism & Plant-based'
  ],
  'Travel & Outdoors': [
    'Travel — Domestic India', 'Travel — International',
    'Trekking & Hiking', 'Adventure Sports', 'Road Trips',
    'Beach & Mountains', 'Backpacking', 'Luxury Travel'
  ],
  'Fitness & Wellness': [
    'Running & Jogging', 'Yoga', 'Gym & Weight Training',
    'Cycling', 'Swimming', 'Martial Arts',
    'Mental Health & Mindfulness', 'Ayurveda & Holistic Health', 'Dance'
  ],
  'Sports': [
    'Cricket', 'Football / Soccer', 'Badminton', 'Tennis',
    'Formula 1', 'Basketball', 'Kabaddi', 'Chess',
    'Fantasy Sports', 'Olympics & Athletics'
  ],
  'Mind & Learning': [
    'History & Culture', 'Science & Space', 'Philosophy',
    'Current Affairs & Politics', 'Personal Finance & Investing',
    'Startups & Entrepreneurship', 'Artificial Intelligence & Tech',
    'Environment & Climate', 'Learning Languages', 'Psychology'
  ],
  'Entertainment': [
    'OTT & Web Series', 'Gaming — Mobile', 'Gaming — PC/Console',
    'Anime & Manga', 'Fashion & Style', 'Beauty & Skincare',
    'Astrology & Spirituality', 'Celebrity & Pop Culture'
  ],
  'Life & Community': [
    'Parenting', 'Pets & Animals', 'Volunteering & Social Causes',
    'LGBTQ+', 'Women & Feminism', 'Sustainability & Minimalism',
    'Home Decor & Interiors', 'Gardening & Plants', 'Automobiles & Bikes'
  ]
}

// ── Shared UI components ───────────────────────────────────────────────────

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
      padding: '8px 12px',
      background: selected ? '#C8A45A' : '#2A2A2A',
      color: selected ? '#1A1A1A' : '#777',
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
      <label style={labelStyle}>{label}</label>
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
      <label style={labelStyle}>{label}</label>
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

function SkipLink({ onSkip }: { onSkip: () => void }) {
  return (
    <button onClick={onSkip} style={{
      background: 'none', border: 'none',
      fontFamily: "'DM Mono', monospace",
      fontSize: '9px', letterSpacing: '1px',
      color: '#444', cursor: 'pointer',
      textDecoration: 'underline', minHeight: '44px',
      marginTop: '8px'
    }}>Skip this step →</button>
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

  // Step 0 — Standard vs Personalised
  const [briefType, setBriefType] = useState<'standard' | 'personalised' | ''>('')

  // Step 1 — About you
  const [age, setAge] = useState('')
  const [gender, setGender] = useState('')

  // Step 2 — Cities
  const [cityCurrente, setCityCurrent] = useState('')
  const [cityHome, setCityHome] = useState('')
  const [sameAsCurrentCity, setSameAsCurrentCity] = useState(false)
  const [extraCities, setExtraCities] = useState<string[]>(['', '', ''])

  // Step 3 — Life stage & work
  const [lifeStage, setLifeStage] = useState('')
  const [workArea, setWorkArea] = useState('')
  const [industry, setIndustry] = useState('')
  const [company, setCompany] = useState('')
  const [studyArea, setStudyArea] = useState('')
  const [studyLevel, setStudyLevel] = useState('')

  // Step 4 — Interests
  const [interests, setInterests] = useState<string[]>([])

  // Step 5 — Preferences
  const [mood, setMood] = useState('neutral')
  const [edition, setEdition] = useState('standard')

  // Steps for personalised flow
  const personalisedSteps = 5
  const totalSteps = briefType === 'personalised' ? personalisedSteps : 1

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
    if (!user) { router.push('/login'); return }

    const allCities = [
      cityCurrente,
      sameAsCurrentCity ? cityCurrente : cityHome,
      ...extraCities.filter(Boolean)
    ].filter(Boolean)

    await supabase.from('profiles').update({
      age: age ? parseInt(age) : null,
      gender: gender || null,
      city_current: cityCurrente || null,
      city_home: sameAsCurrentCity ? cityCurrente : (cityHome || null),
      extra_cities: extraCities.filter(Boolean),
      life_stage: lifeStage || null,
      work_area: workArea || null,
      industry: industry || null,
      company: company || null,
      study_area: studyArea || null,
      study_level: studyLevel || null,
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

  const btnPrimary = (enabled: boolean): React.CSSProperties => ({
    flex: 1, padding: '16px',
    background: enabled ? '#C8A45A' : '#2A2A2A',
    color: enabled ? '#1A1A1A' : '#444',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px', fontWeight: '600',
    letterSpacing: '1px', textTransform: 'uppercase',
    border: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
    borderRadius: '2px', minHeight: '52px', transition: 'all 0.2s'
  })

  return (
    <div style={containerStyle}>
      <div style={{ maxWidth: '400px', width: '100%', margin: '0 auto', flex: 1 }}>

        {briefType && (
          <StepDots
            total={briefType === 'personalised' ? personalisedSteps : 1}
            current={step}
          />
        )}

        {/* ── STEP 0: Standard vs Personalised ── */}
        {step === 0 && (
          <div>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '9px',
              letterSpacing: '3px', color: '#C8A45A', marginBottom: '16px'
            }}>WELCOME</div>
            <h2 style={headStyle}>How would you like your brief?</h2>
            <p style={subStyle}>You can always change this later.</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '32px' }}>
              {[
                {
                  id: 'standard',
                  title: 'Standard Brief',
                  desc: 'Top stories from India and the world. No setup needed — start reading immediately.',
                  covers: ['Top 5 world stories', 'Top 3 India stories', 'Markets snapshot', 'Sport & culture']
                },
                {
                  id: 'personalised',
                  title: 'Personalised Brief',
                  desc: 'Tailored to your city, profession, and interests. Takes 3 minutes to set up.',
                  covers: ['Your city\'s local news', 'Industry-specific business', 'Topics you care about', 'Tone you prefer']
                }
              ].map(opt => (
                <button key={opt.id} onClick={() => setBriefType(opt.id as any)} style={{
                  padding: '20px',
                  background: briefType === opt.id ? 'rgba(200,164,90,0.08)' : '#1E1E1E',
                  border: `1px solid ${briefType === opt.id ? '#C8A45A' : '#2A2A2A'}`,
                  borderRadius: '2px', cursor: 'pointer', textAlign: 'left', minHeight: '44px'
                }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '17px', fontWeight: '700',
                    color: briefType === opt.id ? '#C8A45A' : '#F5F1EA',
                    marginBottom: '6px'
                  }}>{opt.title}</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px', color: '#666',
                    lineHeight: '1.5', marginBottom: '12px'
                  }}>{opt.desc}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {opt.covers.map(c => (
                      <div key={c} style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: '9px', letterSpacing: '0.5px',
                        color: briefType === opt.id ? '#C8A45A' : '#444',
                        display: 'flex', gap: '6px', alignItems: 'center'
                      }}>
                        <span>◆</span>{c}
                      </div>
                    ))}
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={next}
              disabled={!briefType || saving}
              style={btnPrimary(!!briefType && !saving)}
            >
              {saving ? 'Setting up...' :
                briefType === 'standard' ? 'Start Reading →' :
                  briefType === 'personalised' ? 'Set Up My Profile →' : 'Choose an option'}
            </button>
          </div>
        )}

        {/* ── STEP 1: About you ── */}
        {step === 1 && briefType === 'personalised' && (
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '16px' }}>STEP 1 OF {personalisedSteps}</div>
            <h2 style={headStyle}>A little about you</h2>
            <p style={subStyle}>All optional — helps us frame stories for your perspective.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div>
                <label style={labelStyle}>Age</label>
                <input type="number" value={age} onChange={e => setAge(e.target.value)}
                  placeholder="32" style={{
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
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '16px' }}>STEP 2 OF {personalisedSteps}</div>
            <h2 style={headStyle}>Your cities</h2>
            <p style={subStyle}>We cover local news for every city you add. Add up to 5.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <SelectInput label="City you live in now" value={cityCurrente}
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
                <label style={labelStyle}>Other cities you want covered (optional)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {extraCities.map((city, idx) => (
                    <select key={idx} value={city} onChange={e => updateExtraCity(idx, e.target.value)} style={{
                      width: '100%', padding: '14px 16px', background: '#2A2A2A',
                      border: `1px solid ${city ? '#C8A45A' : '#2A2A2A'}`,
                      color: city ? '#F5F1EA' : '#444',
                      fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                      outline: 'none', borderRadius: '2px', appearance: 'none' as const
                    }}>
                      <option value="">+ Add another city</option>
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
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '16px' }}>STEP 3 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What do you do?</h2>
            <p style={subStyle}>Shapes how we cover business and economy news.</p>

            <div style={{ marginBottom: '24px' }}>
              <label style={labelStyle}>Which best describes you?</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {LIFE_STAGES.map(ls => (
                  <button key={ls.id} onClick={() => setLifeStage(ls.id)} style={{
                    padding: '14px 16px', textAlign: 'left',
                    background: lifeStage === ls.id ? 'rgba(200,164,90,0.08)' : '#1E1E1E',
                    border: `1px solid ${lifeStage === ls.id ? '#C8A45A' : '#2A2A2A'}`,
                    borderRadius: '2px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '12px', minHeight: '48px'
                  }}>
                    <span style={{ fontSize: '18px' }}>{ls.icon}</span>
                    <span style={{
                      fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                      color: lifeStage === ls.id ? '#C8A45A' : '#C8C4BC'
                    }}>{ls.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Adaptive fields */}
            {(lifeStage === 'professional' || lifeStage === 'freelancer') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Area of work" value={workArea} onChange={setWorkArea} options={WORK_AREAS} />
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                <TextInput label="Company name (optional)" value={company} onChange={setCompany} placeholder="e.g. Amazon" />
              </div>
            )}
            {lifeStage === 'business' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Industry" value={industry} onChange={setIndustry} options={INDUSTRIES} />
                <TextInput label="Company / venture name (optional)" value={company} onChange={setCompany} placeholder="e.g. My Startup" />
              </div>
            )}
            {lifeStage === 'student' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SelectInput label="Area of study" value={studyArea} onChange={setStudyArea} options={STUDY_AREAS} />
                <SelectInput label="Level of education" value={studyLevel} onChange={setStudyLevel} options={STUDY_LEVELS} />
              </div>
            )}
            {lifeStage === 'retired' && (
              <SelectInput label="Former industry (optional)" value={industry} onChange={setIndustry} options={INDUSTRIES} placeholder="Select if you'd like..." />
            )}
            {lifeStage === 'between' && (
              <SelectInput label="Former industry (optional)" value={industry} onChange={setIndustry} options={INDUSTRIES} placeholder="Select if you'd like..." />
            )}
          </div>
        )}

        {/* ── STEP 4: Interests ── */}
        {step === 4 && briefType === 'personalised' && (
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '16px' }}>STEP 4 OF {personalisedSteps}</div>
            <h2 style={headStyle}>What are you into?</h2>
            <p style={subStyle}>Pick as many as you like. Shapes culture, sport, and lifestyle coverage.</p>

            {Object.entries(INTERESTS).map(([category, items]) => (
              <div key={category} style={{ marginBottom: '24px' }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '9px',
                  letterSpacing: '1.5px', color: '#555',
                  marginBottom: '10px', textTransform: 'uppercase'
                }}>{category}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {items.map(item => (
                    <Chip key={item} label={item}
                      selected={interests.includes(item)}
                      onToggle={() => toggleInterest(item)} />
                  ))}
                </div>
              </div>
            ))}

            {interests.length > 0 && (
              <div style={{
                position: 'sticky', bottom: '80px',
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                color: '#C8A45A', letterSpacing: '1px',
                background: '#1A1A1A', padding: '8px 0'
              }}>
                {interests.length} selected ✓
              </div>
            )}
          </div>
        )}

        {/* ── STEP 5: Preferences ── */}
        {step === 5 && briefType === 'personalised' && (
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#C8A45A', marginBottom: '16px' }}>STEP 5 OF {personalisedSteps}</div>
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
                  { id: 'ultra', label: '5 Min' },
                  { id: 'standard', label: '10 Min' },
                  { id: 'deep', label: 'Deep' },
                ].map(e => (
                  <button key={e.id} onClick={() => setEdition(e.id)} style={{
                    flex: 1, padding: '14px 8px',
                    background: edition === e.id ? 'rgba(200,164,90,0.08)' : '#1E1E1E',
                    border: `1px solid ${edition === e.id ? '#C8A45A' : '#2A2A2A'}`,
                    borderRadius: '2px', cursor: 'pointer', minHeight: '48px'
                  }}>
                    <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', fontWeight: '600', color: edition === e.id ? '#C8A45A' : '#F5F1EA' }}>{e.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Navigation ── */}
        {(briefType || step === 0) && (
          <div style={{ display: 'flex', gap: '12px', marginTop: '36px', paddingBottom: '48px' }}>
            {step > 0 && (
              <button onClick={back} style={{
                padding: '16px 20px', background: 'transparent',
                color: '#555', fontFamily: "'DM Sans', sans-serif",
                fontSize: '14px', border: '1px solid #2A2A2A',
                cursor: 'pointer', borderRadius: '2px', minHeight: '52px'
              }}>← Back</button>
            )}

            {step > 0 && step < (briefType === 'personalised' ? personalisedSteps : 1) && (
              <SkipLink onSkip={next} />
            )}

            {(step > 0 || briefType) && (
              <button
                onClick={() => {
                  if (step === 0) { next() }
                  else if (step < (personalisedSteps)) { setStep(s => s + 1) }
                  else { handleFinish() }
                }}
                disabled={step === 0 && !briefType || saving}
                style={btnPrimary((step > 0 || !!briefType) && !saving)}
              >
                {saving ? 'Saving...' :
                  step === 0 ? (briefType === 'standard' ? 'Start Reading →' : 'Continue →') :
                    step === personalisedSteps ? 'Build My Brief →' : 'Continue →'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
