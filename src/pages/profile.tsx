// src/pages/profile.tsx
//
// Sprint 9 — inline edit per field. Tap a field's pencil icon to edit it in
// place; Save writes that single column to Supabase. Card-level edit is used
// only for tightly grouped fields (cities, work/study group, interests).
//
// Brief type can be toggled directly here (Standard ↔ Personalised) without
// going through onboarding.
//
// Removed entirely: analysis tone (mood_preference) and default reading depth
// (edition_preference) UI — these inputs weren't used anywhere.

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

// ─── Option lists (kept in sync with onboarding.tsx) ────────────────────────

const CITIES = [
  'Bengaluru', 'Delhi / NCR', 'Mumbai', 'Hyderabad', 'Chennai',
  'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow',
  'Chandigarh', 'Kochi', 'Indore', 'Bhopal', 'Nagpur',
  'Surat', 'Visakhapatnam', 'Coimbatore', 'Vadodara', 'Other',
]

const GENDERS = ['Woman', 'Man', 'Non-binary', 'Prefer not to say']

const LIFE_STAGES = [
  { id: 'student', label: 'Student' },
  { id: 'early_career', label: 'Early Career (0–5 yrs)' },
  { id: 'mid_career', label: 'Mid Career (5–15 yrs)' },
  { id: 'senior', label: 'Senior Professional (15+ yrs)' },
  { id: 'business', label: 'Business Owner' },
  { id: 'freelancer', label: 'Freelancer / Consultant' },
  { id: 'homemaker', label: 'Homemaker' },
  { id: 'retired', label: 'Retired' },
  { id: 'prefer_not', label: 'Prefer not to say' },
]
const LIFE_STAGE_LABELS: Record<string, string> = Object.fromEntries(
  LIFE_STAGES.map(s => [s.id, s.label])
)

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

// ─── Styles ─────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  padding: '22px',
  marginBottom: '16px',
}

const sectionHead: React.CSSProperties = {
  fontFamily: "'DM Mono', monospace",
  fontSize: '10px', letterSpacing: '2px',
  color: C.gold, marginBottom: '16px',
  textTransform: 'uppercase',
}

const fieldLabel: React.CSSProperties = {
  fontFamily: "'DM Mono', monospace", fontSize: '10px',
  letterSpacing: '1.5px', color: C.textMute,
}

const fieldValue: React.CSSProperties = {
  fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
  color: C.text, lineHeight: 1.5,
}

const inputBase: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: C.surface2,
  border: `1px solid ${C.borderHi}`,
  color: C.text, fontFamily: "'DM Sans', sans-serif",
  fontSize: '15px', outline: 'none', borderRadius: '3px',
  boxSizing: 'border-box',
}

const editBtnBase: React.CSSProperties = {
  background: 'none', border: 'none',
  color: C.gold, fontFamily: "'DM Mono', monospace",
  fontSize: '11px', letterSpacing: '1.5px',
  cursor: 'pointer', padding: '6px 8px',
  textTransform: 'uppercase',
}

const saveBtn: React.CSSProperties = {
  padding: '10px 18px', background: C.gold,
  color: '#0E0E0E', fontFamily: "'DM Sans', sans-serif",
  fontSize: '12px', fontWeight: 700,
  letterSpacing: '1.5px', textTransform: 'uppercase',
  border: 'none', borderRadius: '3px',
  cursor: 'pointer', minHeight: '40px',
}

const cancelBtn: React.CSSProperties = {
  padding: '10px 18px', background: 'transparent',
  color: C.textMute, fontFamily: "'DM Sans', sans-serif",
  fontSize: '12px', fontWeight: 500,
  border: `1px solid ${C.border}`, borderRadius: '3px',
  cursor: 'pointer', minHeight: '40px',
}

// ─── Editable row component ─────────────────────────────────────────────────

function EditableRow({
  label, displayValue, editing, onStartEdit, onCancel, onSave, children, isLast,
}: {
  label: string
  displayValue: React.ReactNode
  editing: boolean
  onStartEdit: () => void
  onCancel: () => void
  onSave: () => void
  children: React.ReactNode
  isLast?: boolean
}) {
  if (editing) {
    return (
      <div style={{
        padding: '14px 0',
        borderBottom: isLast ? 'none' : `1px solid ${C.border}`,
      }}>
        <div style={{ ...fieldLabel, marginBottom: '10px' }}>{label.toUpperCase()}</div>
        <div style={{ marginBottom: '12px' }}>{children}</div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={cancelBtn}>Cancel</button>
          <button type="button" onClick={onSave} style={saveBtn}>Save</button>
        </div>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', padding: '12px 0', gap: '14px',
      borderBottom: isLast ? 'none' : `1px solid ${C.border}`,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
        <span style={fieldLabel}>{label.toUpperCase()}</span>
        <span style={{ ...fieldValue, color: displayValue ? C.text : C.textDim }}>
          {displayValue || '—'}
        </span>
      </div>
      <button type="button" onClick={onStartEdit} style={editBtnBase} aria-label={`Edit ${label}`}>
        Edit ✏
      </button>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  // One field at a time. null = nothing editing.
  const [editing, setEditing] = useState<string | null>(null)
  // Draft value for the currently-editing field (typed loosely per field).
  const [draft, setDraft] = useState<any>(null)
  const [savingField, setSavingField] = useState(false)

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()

      // Backfill full_name from auth metadata if missing on the profile row.
      const metaName = (user.user_metadata as any)?.full_name as string | undefined
      if (data && !data.full_name && metaName) {
        await supabase.from('profiles').update({ full_name: metaName }).eq('id', user.id)
        data.full_name = metaName
      }

      if (data) setProfile(data)
    }
    load()
  }, [])

  if (!profile) return null

  // ─── Field edit helpers ───────────────────────────────────────────────────

  const startEdit = (field: string, initial: any) => {
    setEditing(field)
    setDraft(initial)
  }

  const cancel = () => {
    setEditing(null)
    setDraft(null)
  }

  // Save a single column (or set of columns) and patch local state.
  const saveFields = async (updates: Record<string, any>) => {
    setSavingField(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSavingField(false); return }
    const { error } = await supabase.from('profiles').update({
      ...updates,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id)
    setSavingField(false)
    if (error) {
      console.error('Save failed:', error)
      alert('Save failed. Please try again.')
      return
    }
    // Sprint 13: brief_type sync defect (open since Sprint 12.5) — the client
    // DOES write brief_type on updates, so if the value isn't sticking the
    // failure is silent (likely RLS column policy). Read back and verify so
    // the defect becomes visible instead of silent.
    if ('brief_type' in updates) {
      const { data: check } = await supabase
        .from('profiles').select('brief_type').eq('id', user.id).single()
      if (check && check.brief_type !== updates.brief_type) {
        console.error(`[brief_type] write did not persist: wanted=${updates.brief_type} got=${check.brief_type}`)
        alert('Your brief type setting did not save — please report this. (Likely a permissions issue.)')
        return
      }
    }
    setProfile(p => p ? ({ ...p, ...updates } as any) : p)
    setEditing(null)
    setDraft(null)
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    await supabase.auth.signOut()
    router.push('/')
  }

  const isPersonalised = profile.brief_type === 'personalised'

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

        {/* ─── Identity card (read-only display) ───────────────────────── */}
        <div style={{ ...cardStyle, borderTop: `3px solid ${C.gold}` }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '26px', fontWeight: 700, color: C.text,
            marginBottom: '4px', lineHeight: 1.25,
          }}>{profile.full_name || 'Reader'}</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.2px', color: C.textMute,
          }}>{profile.email}</div>
        </div>

        {/* ─── Brief type toggle ───────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={sectionHead}>Brief Type</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {(['standard', 'personalised'] as const).map(t => {
              const selected = profile.brief_type === t
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    if (selected || savingField) return
                    saveFields({ brief_type: t })
                  }}
                  disabled={savingField}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '16px 12px',
                    background: selected ? C.goldSoft : C.surface2,
                    border: `1px solid ${selected ? C.gold : C.border}`,
                    borderRadius: '3px',
                    cursor: selected ? 'default' : 'pointer',
                    textAlign: 'left',
                    minHeight: '76px',
                  }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '16px', fontWeight: 700,
                    color: selected ? C.gold : C.text,
                    marginBottom: '4px',
                  }}>{t === 'standard' ? 'Standard' : 'Personalised'}</div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '1.5px', color: C.textMute,
                  }}>{selected ? 'CURRENT' : 'TAP TO SWITCH'}</div>
                </button>
              )
            })}
          </div>
          {isPersonalised && (
            <div style={{
              marginTop: '12px',
              fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
              color: C.textMute, lineHeight: 1.55,
            }}>
              Personalised uses your city and interests to reorder stories and add
              a "Your city" section. Standard shows the same brief to everyone.
            </div>
          )}
        </div>

        {/* ─── Personal ────────────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={sectionHead}>Personal</div>

          {/* Age */}
          <EditableRow
            label="Age"
            displayValue={profile.age}
            editing={editing === 'age'}
            onStartEdit={() => startEdit('age', profile.age ? String(profile.age) : '')}
            onCancel={cancel}
            onSave={() => {
              const parsed = draft ? parseInt(draft) : null
              saveFields({ age: parsed && !isNaN(parsed) ? parsed : null })
            }}
          >
            <input
              type="number"
              value={draft || ''}
              onChange={e => setDraft(e.target.value)}
              placeholder="e.g. 28"
              style={inputBase}
            />
          </EditableRow>

          {/* Gender */}
          <EditableRow
            label="Gender"
            displayValue={profile.gender}
            editing={editing === 'gender'}
            onStartEdit={() => startEdit('gender', profile.gender || '')}
            onCancel={cancel}
            onSave={() => saveFields({ gender: draft || null })}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {GENDERS.map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setDraft(g === draft ? '' : g)}
                  style={{
                    padding: '10px 14px',
                    background: draft === g ? C.gold : C.surface2,
                    color: draft === g ? '#1A1A1A' : C.textSoft,
                    fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                    fontWeight: draft === g ? 600 : 400,
                    border: `1px solid ${draft === g ? C.gold : C.border}`,
                    borderRadius: '3px', cursor: 'pointer',
                    minHeight: '40px',
                  }}>{g}</button>
              ))}
            </div>
          </EditableRow>

          {/* City current */}
          <EditableRow
            label="Lives in"
            displayValue={profile.city_current}
            editing={editing === 'city_current'}
            onStartEdit={() => startEdit('city_current', profile.city_current || '')}
            onCancel={cancel}
            onSave={() => saveFields({ city_current: draft || null })}
          >
            <select value={draft || ''} onChange={e => setDraft(e.target.value)} style={{ ...inputBase, appearance: 'none' as const }}>
              <option value="">Select city...</option>
              {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </EditableRow>

          {/* City home */}
          <EditableRow
            label="From"
            displayValue={profile.city_home}
            editing={editing === 'city_home'}
            onStartEdit={() => startEdit('city_home', profile.city_home || '')}
            onCancel={cancel}
            onSave={() => saveFields({ city_home: draft || null })}
          >
            <select value={draft || ''} onChange={e => setDraft(e.target.value)} style={{ ...inputBase, appearance: 'none' as const }}>
              <option value="">Select home city...</option>
              {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </EditableRow>

          {/* Extra cities */}
          <EditableRow
            label="Also covers"
            displayValue={
              (profile as any).extra_cities?.length > 0
                ? (profile as any).extra_cities.join(', ')
                : null
            }
            editing={editing === 'extra_cities'}
            onStartEdit={() => {
              const padded = [...((profile as any).extra_cities || []), '', '', ''].slice(0, 3)
              startEdit('extra_cities', padded)
            }}
            onCancel={cancel}
            onSave={() => saveFields({ extra_cities: (draft as string[]).filter(Boolean) })}
            isLast
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {(draft as string[] || ['', '', '']).map((c, idx) => (
                <select
                  key={idx}
                  value={c}
                  onChange={e => {
                    const updated = [...(draft as string[])]
                    updated[idx] = e.target.value
                    setDraft(updated)
                  }}
                  style={{ ...inputBase, appearance: 'none' as const }}>
                  <option value="">+ Add city {idx + 1}</option>
                  {CITIES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ))}
            </div>
          </EditableRow>
        </div>

        {/* ─── Work & Study (card-level edit because fields depend on life_stage) ── */}
        <div style={cardStyle}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: '16px',
          }}>
            <div style={{ ...sectionHead, marginBottom: 0 }}>Work & Study</div>
            {editing !== 'work_block' && (
              <button
                type="button"
                onClick={() => startEdit('work_block', {
                  life_stage: (profile as any).life_stage || '',
                  work_area: (profile as any).work_area || '',
                  industry: profile.industry || '',
                  company: profile.company || '',
                  study_area: (profile as any).study_area || '',
                  study_level: (profile as any).study_level || '',
                })}
                style={editBtnBase}>
                Edit ✏
              </button>
            )}
          </div>

          {editing !== 'work_block' && (
            <>
              <ReadRow label="Status" value={LIFE_STAGE_LABELS[(profile as any).life_stage || ''] || (profile as any).life_stage} />
              <ReadRow label="Area" value={(profile as any).work_area || (profile as any).study_area} />
              <ReadRow label="Industry" value={profile.industry} />
              <ReadRow label="Company" value={profile.company} isLast={!(profile as any).study_level} />
              <ReadRow label="Study level" value={(profile as any).study_level} isLast />
            </>
          )}

          {editing === 'work_block' && (
            <WorkBlockEditor
              draft={draft}
              setDraft={setDraft}
              onCancel={cancel}
              onSave={() => {
                const d = draft
                const isWorkingPro = ['early_career', 'mid_career', 'senior'].includes(d.life_stage)
                const isFreelancer = d.life_stage === 'freelancer'
                const isBusiness = d.life_stage === 'business'
                const isStudent = d.life_stage === 'student'
                saveFields({
                  life_stage: d.life_stage || null,
                  work_area: (isWorkingPro || isFreelancer) ? (d.work_area || null) : null,
                  industry: (isWorkingPro || isFreelancer || isBusiness) ? (d.industry || null) : null,
                  company: (isWorkingPro || isBusiness) ? (d.company || null) : null,
                  study_area: isStudent ? (d.study_area || null) : null,
                  study_level: isStudent ? (d.study_level || null) : null,
                })
              }}
            />
          )}
        </div>

        {/* ─── Interests (card-level: 30+ chips don't fit a row layout) ── */}
        <div style={cardStyle}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: '16px',
          }}>
            <div style={{ ...sectionHead, marginBottom: 0 }}>
              Interests {profile.interests?.length ? `(${profile.interests.length})` : ''}
            </div>
            {editing !== 'interests' && (
              <button
                type="button"
                onClick={() => startEdit('interests', profile.interests || [])}
                style={editBtnBase}>
                Edit ✏
              </button>
            )}
          </div>

          {editing !== 'interests' && (
            profile.interests?.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {profile.interests.map(i => (
                  <span key={i} style={{
                    padding: '6px 12px', background: C.goldSoft,
                    border: `1px solid ${C.goldBorder}`,
                    borderRadius: '2px',
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px', color: C.gold,
                  }}>{i}</span>
                ))}
              </div>
            ) : (
              <div style={{ ...fieldValue, color: C.textDim }}>—</div>
            )
          )}

          {editing === 'interests' && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
                {INTERESTS_ALL.map(item => {
                  const selected = (draft as string[]).includes(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        const list = draft as string[]
                        setDraft(selected ? list.filter(x => x !== item) : [...list, item])
                      }}
                      style={{
                        padding: '10px 14px',
                        background: selected ? C.gold : C.surface2,
                        color: selected ? '#1A1A1A' : C.textSoft,
                        fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                        fontWeight: selected ? 600 : 400,
                        border: `1px solid ${selected ? C.gold : C.border}`,
                        borderRadius: '3px', cursor: 'pointer',
                        minHeight: '40px',
                      }}>{item}</button>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button type="button" onClick={cancel} style={cancelBtn}>Cancel</button>
                <button type="button" onClick={() => saveFields({ interests: draft })} style={saveBtn}>Save</button>
              </div>
            </>
          )}
        </div>

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
          marginTop: '24px',
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
          // Sprint 14: 4 tabs — Brief · Stories · Desks · Profile.
          { href: '/home',      label: 'Brief',   icon: '◆', active: false },
          { href: '/followed',  label: 'Stories', icon: '◉', active: false },
          { href: '/desks',     label: 'Desks',   icon: '▦', active: false },
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

// ─── Sub-components for the Work & Study block ─────────────────────────────

function ReadRow({ label, value, isLast }: { label: string; value: any; isLast?: boolean }) {
  if (!value) return null
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'flex-start', padding: '10px 0', gap: '14px',
      borderBottom: isLast ? 'none' : `1px solid ${C.border}`,
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
  )
}

function WorkBlockEditor({
  draft, setDraft, onCancel, onSave,
}: {
  draft: any
  setDraft: (v: any) => void
  onCancel: () => void
  onSave: () => void
}) {
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v })
  const isWorkingPro = ['early_career', 'mid_career', 'senior'].includes(draft.life_stage)
  const isFreelancer = draft.life_stage === 'freelancer'
  const isBusiness = draft.life_stage === 'business'
  const isStudent = draft.life_stage === 'student'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div>
        <div style={{ ...fieldLabel, marginBottom: '10px' }}>STATUS</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          {LIFE_STAGES.map(ls => (
            <button
              key={ls.id}
              type="button"
              onClick={() => set('life_stage', ls.id)}
              style={{
                padding: '12px 10px',
                background: draft.life_stage === ls.id ? C.goldSoft : C.surface2,
                border: `1px solid ${draft.life_stage === ls.id ? C.gold : C.border}`,
                color: draft.life_stage === ls.id ? C.gold : C.textSoft,
                borderRadius: '3px', cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif", fontSize: '12px',
                minHeight: '50px', textAlign: 'center',
              }}>{ls.label}</button>
          ))}
        </div>
      </div>

      {(isWorkingPro || isFreelancer) && (
        <SimpleSelect label="Area of work" value={draft.work_area} options={WORK_AREAS} onChange={v => set('work_area', v)} />
      )}
      {(isWorkingPro || isFreelancer || isBusiness) && (
        <SimpleSelect label="Industry" value={draft.industry} options={INDUSTRIES} onChange={v => set('industry', v)} />
      )}
      {(isWorkingPro || isBusiness) && (
        <div>
          <div style={{ ...fieldLabel, marginBottom: '10px' }}>COMPANY (OPTIONAL)</div>
          <input
            type="text"
            value={draft.company || ''}
            onChange={e => set('company', e.target.value)}
            placeholder="e.g. Amazon"
            style={inputBase}
          />
        </div>
      )}
      {isStudent && (
        <>
          <SimpleSelect label="Area of study" value={draft.study_area} options={STUDY_AREAS} onChange={v => set('study_area', v)} />
          <SimpleSelect label="Level of education" value={draft.study_level} options={STUDY_LEVELS} onChange={v => set('study_level', v)} />
        </>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={cancelBtn}>Cancel</button>
        <button type="button" onClick={onSave} style={saveBtn}>Save</button>
      </div>
    </div>
  )
}

function SimpleSelect({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <div>
      <div style={{ ...fieldLabel, marginBottom: '10px' }}>{label.toUpperCase()}</div>
      <select value={value || ''} onChange={e => onChange(e.target.value)} style={{ ...inputBase, appearance: 'none' as const }}>
        <option value="">Select...</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}
