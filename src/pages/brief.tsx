import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

// ─── Design tokens (kept inline to avoid new import paths) ───────────────────
const C = {
  bg: '#0E0E0E',
  surface: '#161616',
  surface2: '#1E1E1E',
  border: '#262626',
  borderHi: '#3A3A3A',
  gold: '#C8A45A',
  goldSoft: 'rgba(200,164,90,0.10)',
  text: '#F5F1EA',
  textSoft: '#CFC6B8',
  textMute: '#8E867B',
  textDim: '#5E574D',
  ok: '#5FB87E',
  err: '#E76161',
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Story {
  headline: string
  body: string
  source: string
  source_url?: string
  industries?: string[]
  interests?: string[]
}

interface MarketIndex {
  name: string
  change: string
}

interface Closer {
  headlines_to_remember: string[]
  things_to_watch: string[]
  conversation_insight: string
}

interface PersonalSection {
  id: string
  label: string
  icon: string
  kind: 'list'
  stories: Story[]
}

interface BriefContent {
  edition: string
  date: string
  major_events?: Story[]
  world: Story[]
  india: Story[]
  bengaluru?: Story[]
  delhi?: Story[]
  business: Story[]
  technology: Story[]
  climate_health: Story[]
  markets: {
    summary: string
    indices: MarketIndex[]
  }
  sport: Story
  culture: Story
  closer?: Closer
  personal_sections?: PersonalSection[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function editionLabel(edition: string) {
  if (edition === '5min') return '5-MIN READ'
  if (edition === '10min') return '10-MIN READ'
  if (edition === 'deep') return 'DEEP DIVE'
  return edition.toUpperCase()
}

function marketColor(change: string) {
  if (change.startsWith('+')) return C.ok
  if (change.startsWith('-')) return C.err
  return C.textMute
}

// ─── Section catalogue ───────────────────────────────────────────────────────

type SectionKind = 'list' | 'single' | 'markets'

interface SectionDef {
  id: string
  label: string
  icon: string
  kind: SectionKind
}

// major_events sits at the top — sustained themes worth knowing.
// bengaluru/delhi kept for backward-compat reads of older briefs; new briefs
// don't write them, so the sectionHasContent filter hides them automatically.
const ALL_SECTIONS: SectionDef[] = [
  { id: 'major_events',   label: 'Major Events', icon: '🔥', kind: 'list' },
  { id: 'world',          label: 'World',     icon: '🌍', kind: 'list' },
  { id: 'india',          label: 'India',     icon: '🇮🇳', kind: 'list' },
  { id: 'bengaluru',      label: 'Bengaluru', icon: '🏙️', kind: 'list' },
  { id: 'delhi',          label: 'Delhi',     icon: '🏛️', kind: 'list' },
  { id: 'business',       label: 'Business',  icon: '💼', kind: 'list' },
  { id: 'markets',        label: 'Markets',   icon: '📈', kind: 'markets' },
  { id: 'technology',     label: 'Tech',      icon: '💻', kind: 'list' },
  { id: 'climate_health', label: 'Climate',   icon: '🌱', kind: 'list' },
  { id: 'sport',          label: 'Sport',     icon: '🏏', kind: 'single' },
  { id: 'culture',        label: 'Culture',   icon: '🎭', kind: 'single' },
]

function sectionHasContent(section: SectionDef, brief: BriefContent): boolean {
  if (section.kind === 'list') {
    const arr = (brief as any)[section.id] as Story[] | undefined
    return Array.isArray(arr) && arr.length > 0
  }
  if (section.kind === 'single') {
    const s = (brief as any)[section.id] as Story | undefined
    return !!(s && s.headline)
  }
  if (section.kind === 'markets') {
    return !!(brief.markets && (brief.markets.summary || (brief.markets.indices?.length ?? 0) > 0))
  }
  return false
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: '30px',
      fontWeight: 800,
      color: C.gold,
      marginBottom: '6px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      lineHeight: 1.15,
    }}>{children}</div>
  )
}

function SourceLine({ story }: { story: Story }) {
  const sharedStyle: React.CSSProperties = {
    fontFamily: "'DM Mono', monospace",
    fontSize: '11px',
    letterSpacing: '1.5px',
    color: C.textMute,
    textDecoration: 'none',
  }
  if (story.source_url) {
    return (
      <a
        href={story.source_url}
        target="_blank"
        rel="noopener noreferrer"
        style={sharedStyle}
      >
        via {story.source} ↗
      </a>
    )
  }
  return <div style={sharedStyle}>via {story.source}</div>
}

function StoryCard({
  story,
  isSaved,
  onToggle,
}: {
  story: Story
  isSaved: boolean
  onToggle: () => void
}) {
  return (
    <div style={{
      padding: '24px 0',
      borderBottom: `1px solid ${C.border}`,
    }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '23px',
        fontWeight: 700,
        color: C.text,
        lineHeight: 1.32,
        marginBottom: '14px',
      }}>{story.headline}</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '17px',
        color: C.textSoft,
        lineHeight: 1.75,
        marginBottom: '16px',
      }}>{story.body}</div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <SourceLine story={story} />

        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 4px',
            minHeight: '44px',
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            letterSpacing: '1.5px',
            color: isSaved ? C.gold : C.textMute,
          }}
          title={isSaved ? 'Remove from saved' : 'Save this story'}
        >
          <span style={{ fontSize: '17px' }}>{isSaved ? '★' : '☆'}</span>
          {isSaved ? 'SAVED' : 'SAVE'}
        </button>
      </div>
    </div>
  )
}

function EditionTab({
  label, active, onClick
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: 'none',
        border: 'none',
        borderBottom: active ? `2px solid ${C.gold}` : '2px solid transparent',
        padding: '14px 0',
        fontFamily: "'DM Mono', monospace",
        fontSize: '11px',
        letterSpacing: '2px',
        color: active ? C.gold : C.textMute,
        cursor: 'pointer',
        transition: 'color 0.15s',
      }}
    >{label}</button>
  )
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function BriefLoading() {
  return (
    <div style={{ padding: '80px 20px', textAlign: 'center' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '22px',
        fontStyle: 'italic',
        color: C.textMute,
      }}>Fetching your brief…</div>
    </div>
  )
}

// ─── No brief ─────────────────────────────────────────────────────────────────

function NoBrief({ profile }: { profile: Profile | null }) {
  const edPref = (profile?.edition_preference as string) || '10min'
  const depthLabel = edPref === '5min' ? '5-minute' : edPref === 'deep' ? 'deep dive' : '10-minute'

  return (
    <div style={{ padding: '32px 20px' }}>
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${C.gold}`,
        padding: '28px 24px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '11px',
          letterSpacing: '2px',
          color: C.gold,
          marginBottom: '18px',
        }}>TODAY'S BRIEF IS BEING PREPARED</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '24px',
          fontStyle: 'italic',
          color: C.text,
          marginBottom: '16px',
          lineHeight: 1.4,
        }}>Your first brief arrives tomorrow at 6:45 AM.</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '16px',
          color: C.textSoft,
          lineHeight: 1.7,
          marginBottom: '24px',
        }}>
          Every morning, Morning Brief fetches the day's news and rewrites it in plain, warm English — no noise, no spin. Tailored to {profile?.city_current || 'your city'} and your interests.
        </div>
        {[
          `📍 Local news for ${profile?.city_current || 'your city'}`,
          '🔥 Major events worth tracking',
          '🌍 World affairs & India politics',
          '💼 Markets & business',
          `📖 In ${depthLabel} depth`,
        ].map(item => (
          <div key={item} style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '15px',
            color: C.textSoft,
            padding: '12px 0',
            borderBottom: `1px solid ${C.border}`,
            lineHeight: 1.5,
          }}>{item}</div>
        ))}
      </div>
    </div>
  )
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────

function SidebarNav({
  sections,
  activeSection,
}: {
  sections: SectionDef[]
  activeSection: string
}) {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div style={{
      position: 'fixed',
      left: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      padding: '8px 0',
      background: C.surface,
      borderRight: `1px solid ${C.border}`,
      maxHeight: '90vh',
      overflowY: 'auto',
    }}>
      {sections.map(({ id, label, icon }) => {
        const isActive = activeSection === id
        return (
          <button
            key={id}
            onClick={() => scrollTo(id)}
            style={{
              background: 'none',
              border: 'none',
              borderLeft: isActive ? `2px solid ${C.gold}` : '2px solid transparent',
              padding: '10px 10px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              width: '56px',
            }}
          >
            <span style={{ fontSize: '16px', lineHeight: 1 }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px',
              letterSpacing: '0.6px',
              color: isActive ? C.gold : C.textMute,
              lineHeight: 1,
              textAlign: 'center',
            }}>{label.toUpperCase()}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Brief renderer ──────────────────────────────────────────────────────────

function BriefRenderer({
  brief,
  activeEdition,
  todayISO,
  savedKeys,
  onToggle,
}: {
  brief: BriefContent
  activeEdition: string
  todayISO: string
  savedKeys: Set<string>
  onToggle: (section: string, index: number, story: Story) => void
}) {
  // Only sections that have content today
  const visibleSections = ALL_SECTIONS.filter(s => sectionHasContent(s, brief))

  // Personal sections (e.g. "Your City") spliced in after India for personalised users
  const personalSections = brief.personal_sections ?? []

  // Build the full nav list: visible standard sections + personal sections + closer
  const navSections: SectionDef[] = [...visibleSections]
  // Inject personal sections after India in nav order
  if (personalSections.length > 0) {
    const indiaIdx = navSections.findIndex(s => s.id === 'india')
    const insertAt = indiaIdx >= 0 ? indiaIdx + 1 : navSections.length
    const personalDefs: SectionDef[] = personalSections.map(p => ({
      id: p.id, label: p.label, icon: p.icon, kind: 'list' as const,
    }))
    navSections.splice(insertAt, 0, ...personalDefs)
  }
  if (brief.closer) {
    navSections.push({ id: 'closer', label: 'Recap', icon: '🌙', kind: 'single' })
  }

  const [activeSection, setActiveSection] = useState(navSections[0]?.id ?? 'world')

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...navSections].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 140) {
          setActiveSection(id)
          return
        }
      }
      if (navSections[0]) setActiveSection(navSections[0].id)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief])

  const keyFor = (section: string, index: number) =>
    `${todayISO}-${activeEdition}-${section}-${index}`

  const renderList = (sectionId: string, stories: Story[]) => (
    stories.map((story, i) => (
      <StoryCard
        key={i}
        story={story}
        isSaved={savedKeys.has(keyFor(sectionId, i))}
        onToggle={() => onToggle(sectionId, i, story)}
      />
    ))
  )

  const renderMarkets = () => (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px',
        margin: '20px 0',
      }}>
        {brief.markets.indices?.map((idx) => (
          <div key={idx.name} style={{
            background: C.surface2,
            border: `1px solid ${C.border}`,
            padding: '16px 18px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '11px',
              letterSpacing: '1.5px',
              color: C.textMute,
              marginBottom: '10px',
            }}>{idx.name}</div>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '22px',
              fontWeight: 700,
              color: marketColor(idx.change),
            }}>{idx.change}</div>
          </div>
        ))}
      </div>
      {brief.markets.summary && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '17px',
          color: C.textSoft,
          lineHeight: 1.75,
        }}>{brief.markets.summary}</div>
      )}
    </>
  )

  // ── Splice personal sections after India in render order too ──────────
  type RenderItem =
    | { kind: 'standard'; section: SectionDef }
    | { kind: 'personal'; section: PersonalSection }

  const renderItems: RenderItem[] = []
  for (const section of visibleSections) {
    renderItems.push({ kind: 'standard', section })
    if (section.id === 'india' && personalSections.length > 0) {
      for (const p of personalSections) {
        renderItems.push({ kind: 'personal', section: p })
      }
    }
  }
  // If brief has no India section but has personal sections, append them at the start.
  if (!visibleSections.some(s => s.id === 'india') && personalSections.length > 0) {
    const personalItems: RenderItem[] = personalSections.map(p => ({ kind: 'personal' as const, section: p }))
    renderItems.unshift(...personalItems)
  }

  return (
    <div style={{ position: 'relative' }}>
      <SidebarNav sections={navSections} activeSection={activeSection} />

      <div style={{ padding: '0 20px 40px 72px' }}>
        {renderItems.map((item, idx) => {
          if (item.kind === 'personal') {
            const p = item.section
            return (
              <div
                key={p.id}
                id={p.id}
                style={{ paddingTop: idx === 0 ? '36px' : '44px' }}
              >
                <div style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '2px',
                  color: C.gold,
                  marginBottom: '4px',
                }}>FOR YOU</div>
                <SectionLabel>{p.icon} {p.label}</SectionLabel>
                {renderList(p.id, p.stories)}
              </div>
            )
          }
          const section = item.section
          return (
            <div
              key={section.id}
              id={section.id}
              style={{ paddingTop: idx === 0 ? '36px' : '44px' }}
            >
              <SectionLabel>{section.icon} {section.label}</SectionLabel>

              {section.kind === 'list' &&
                renderList(section.id, (brief as any)[section.id] as Story[])}

              {section.kind === 'single' && (
                <StoryCard
                  story={(brief as any)[section.id] as Story}
                  isSaved={savedKeys.has(keyFor(section.id, 0))}
                  onToggle={() =>
                    onToggle(section.id, 0, (brief as any)[section.id] as Story)
                  }
                />
              )}

              {section.kind === 'markets' && renderMarkets()}
            </div>
          )
        })}

        {brief.closer && <CloserBlock closer={brief.closer} />}
      </div>
    </div>
  )
}

// ─── Closer block ────────────────────────────────────────────────────────────

function CloserBlock({ closer }: { closer: Closer }) {
  return (
    <div id="closer" style={{ paddingTop: '64px', marginTop: '28px', borderTop: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'DM Mono', monospace",
        fontSize: '11px',
        letterSpacing: '2.5px',
        color: C.gold,
        marginBottom: '28px',
      }}>BEFORE YOU CLOSE</div>

      {/* Headlines to remember */}
      <div style={{ marginBottom: '40px' }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px',
          fontWeight: 700,
          color: C.text,
          marginBottom: '18px',
          lineHeight: 1.3,
        }}>Headlines to remember today</div>
        {closer.headlines_to_remember.map((line, i) => (
          <div key={i} style={{
            display: 'flex',
            gap: '14px',
            padding: '12px 0',
            borderBottom: `1px solid ${C.border}`,
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '16px',
            color: C.textSoft,
            lineHeight: 1.6,
          }}>
            <span style={{ color: C.gold, fontWeight: 700, minWidth: '22px' }}>{i + 1}.</span>
            <span>{line}</span>
          </div>
        ))}
      </div>

      {/* Things to watch */}
      <div style={{ marginBottom: '40px' }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px',
          fontWeight: 700,
          color: C.text,
          marginBottom: '18px',
          lineHeight: 1.3,
        }}>Things to watch this week</div>
        {closer.things_to_watch.map((line, i) => (
          <div key={i} style={{
            padding: '12px 0',
            borderBottom: `1px solid ${C.border}`,
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '16px',
            color: C.textSoft,
            lineHeight: 1.65,
          }}>
            <span style={{ color: C.gold, marginRight: '10px' }}>→</span>
            {line}
          </div>
        ))}
      </div>

      {/* Conversation insight */}
      <div style={{
        background: C.surface2,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${C.gold}`,
        padding: '24px',
        marginBottom: '24px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '2px',
          color: C.gold,
          marginBottom: '14px',
        }}>ONE INSIGHT WORTH SHARING</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '19px',
          fontStyle: 'italic',
          color: C.text,
          lineHeight: 1.6,
        }}>{closer.conversation_insight}</div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BriefPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [briefs, setBriefs] = useState<Record<string, BriefContent>>({})
  const [activeEdition, setActiveEdition] = useState<'5min' | '10min' | 'deep'>('10min')

  const [userId, setUserId] = useState<string | null>(null)
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })
  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUserId(user.id)

      const { data: profileData } = await supabase
        .from('profiles').select('*').eq('id', user.id).single()
      setProfile(profileData)

      if (profileData?.edition_preference) {
        const raw = profileData.edition_preference as string
        // Legacy 'ultra' → '5min' normalisation
        const pref = raw === 'ultra' ? '5min' : raw
        if (pref === '5min' || pref === '10min' || pref === 'deep') {
          setActiveEdition(pref as '5min' | '10min' | 'deep')
        }
      }

      const isPersonalised = profileData?.brief_type === 'personalised'
      const loadedBriefs: Record<string, BriefContent> = {}

      if (isPersonalised) {
        const { data: personalised } = await supabase
          .from('personalised_briefs')
          .select('edition, content')
          .eq('user_id', user.id)
          .eq('date', todayISO)
          .in('status', ['ready', 'fallback'])
        if (personalised && personalised.length > 0) {
          personalised.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      if (Object.keys(loadedBriefs).length === 0) {
        const { data: standard } = await supabase
          .from('briefs')
          .select('edition, content')
          .eq('date', todayISO)
          .in('status', ['ready', 'fallback'])
        if (standard && standard.length > 0) {
          standard.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      setBriefs(loadedBriefs)

      const { data: bookmarkRows } = await supabase
        .from('bookmarks')
        .select('brief_date, edition, section, story_index')
        .eq('user_id', user.id)
        .eq('brief_date', todayISO)
      if (bookmarkRows) {
        setSavedKeys(new Set(
          bookmarkRows.map((b: any) =>
            `${b.brief_date}-${b.edition}-${b.section}-${b.story_index}`
          )
        ))
      }

      setLoading(false)
    }
    load()
  }, [])

  const toggleBookmark = async (section: string, index: number, story: Story) => {
    if (!userId) {
      alert('Your session was not found — please log in again.')
      return
    }
    const key = `${todayISO}-${activeEdition}-${section}-${index}`
    const currentlySaved = savedKeys.has(key)

    setSavedKeys(prev => {
      const next = new Set(prev)
      if (currentlySaved) next.delete(key)
      else next.add(key)
      return next
    })

    const revert = () => {
      setSavedKeys(prev => {
        const next = new Set(prev)
        if (currentlySaved) next.add(key)
        else next.delete(key)
        return next
      })
    }

    if (currentlySaved) {
      const { error: deleteError } = await supabase
        .from('bookmarks')
        .delete()
        .eq('user_id', userId)
        .eq('brief_date', todayISO)
        .eq('edition', activeEdition)
        .eq('section', section)
        .eq('story_index', index)
      if (deleteError) {
        revert()
        alert('Could not remove bookmark: ' + deleteError.message)
      }
    } else {
      const { error: insertError } = await supabase
        .from('bookmarks')
        .insert({
          user_id: userId,
          brief_date: todayISO,
          edition: activeEdition,
          section,
          story_index: index,
          headline: story.headline,
          body: story.body,
          source: story.source,
          source_url: story.source_url ?? null,
        })
      if (insertError) {
        revert()
        alert('Could not save bookmark: ' + insertError.message)
      }
    }
  }

  const activeBrief = briefs[activeEdition]
  const hasBriefs = Object.keys(briefs).length > 0

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>

      {/* Header */}
      <div style={{
        background: C.bg,
        borderBottom: `2px solid ${C.gold}`,
        padding: '22px 20px 16px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '14px' }}>
          <Link href="/home" style={{
            color: C.textMute, textDecoration: 'none',
            fontSize: '22px', marginRight: '18px',
            minHeight: '44px', display: 'flex', alignItems: 'center',
          }}>←</Link>
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '30px',
              fontWeight: 900,
              color: C.text,
              lineHeight: 1,
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '30px',
              fontWeight: 900,
              color: C.gold,
              lineHeight: 1,
            }}>Brief</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '1.5px',
              color: C.textMute,
              lineHeight: 1.7,
            }}>{today.toUpperCase()}</div>
            {profile && (
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                letterSpacing: '1.5px',
                color: C.textDim,
              }}>{profile.city_current?.toUpperCase()}</div>
            )}
          </div>
        </div>

        {hasBriefs && (
          <div style={{ display: 'flex', marginTop: '4px' }}>
            {(['5min', '10min', 'deep'] as const).map(ed =>
              briefs[ed] ? (
                <EditionTab
                  key={ed}
                  label={editionLabel(ed)}
                  active={activeEdition === ed}
                  onClick={() => setActiveEdition(ed)}
                />
              ) : null
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ paddingBottom: '88px' }}>
        {loading ? (
          <BriefLoading />
        ) : hasBriefs && activeBrief ? (
          <BriefRenderer
            brief={activeBrief}
            activeEdition={activeEdition}
            todayISO={todayISO}
            savedKeys={savedKeys}
            onToggle={toggleBookmark}
          />
        ) : (
          <NoBrief profile={profile} />
        )}
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: C.surface,
        borderTop: `1px solid ${C.border}`,
        display: 'flex',
        height: '64px',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {[
          { href: '/home',      label: 'Brief',   icon: '◆', active: true },
          { href: '/bookmarks', label: 'Saved',   icon: '★', active: false },
          { href: '/profile',   label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '4px', textDecoration: 'none', minHeight: '60px',
          }}>
            <span style={{ fontSize: '18px', color: active ? C.gold : C.textMute }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px', letterSpacing: '1.5px',
              color: active ? C.gold : C.textMute,
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
}
