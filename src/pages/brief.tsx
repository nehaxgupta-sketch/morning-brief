import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Story {
  headline: string
  body: string
  source: string
}

interface MarketIndex {
  name: string
  change: string
}

interface BriefContent {
  edition: string
  date: string
  world: Story[]
  india: Story[]
  markets: {
    summary: string
    indices: MarketIndex[]
  }
  sport: Story
  culture: Story
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function editionLabel(edition: string) {
  if (edition === '5min') return '5-MIN READ'
  if (edition === '10min') return '10-MIN READ'
  if (edition === 'deep') return 'DEEP DIVE'
  return edition.toUpperCase()
}

function marketColor(change: string) {
  if (change.startsWith('+')) return '#4CAF7D'
  if (change.startsWith('-')) return '#E05C5C'
  return '#aaa'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: '26px',
      fontWeight: '700',
      color: '#C8A45A',
      marginBottom: '4px',
      paddingBottom: '0px',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    }}>{children}</div>
  )
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
      padding: '22px 0',
      borderBottom: '1px solid #2A2A2A',
    }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '22px',
        fontWeight: '700',
        color: '#F5F1EA',
        lineHeight: '1.35',
        marginBottom: '12px',
      }}>{story.headline}</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '17px',
        color: '#C0B9AF',
        lineHeight: '1.8',
        marginBottom: '12px',
      }}>{story.body}</div>

      {/* Source + bookmark row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '11px',
          letterSpacing: '1px',
          color: '#666',
        }}>via {story.source}</div>

        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '6px 4px',
            minHeight: '44px',
            fontFamily: "'DM Mono', monospace",
            fontSize: '10px',
            letterSpacing: '1px',
            color: isSaved ? '#C8A45A' : '#AAA',
          }}
          title={isSaved ? 'Remove from saved' : 'Save this story'}
        >
          <span style={{ fontSize: '16px' }}>{isSaved ? '★' : '☆'}</span>
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
        borderBottom: active ? '2px solid #C8A45A' : '2px solid transparent',
        padding: '13px 0',
        fontFamily: "'DM Mono', monospace",
        fontSize: '10px',
        letterSpacing: '2px',
        color: active ? '#C8A45A' : '#777',
        cursor: 'pointer',
        transition: 'color 0.15s',
      }}
    >{label}</button>
  )
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function BriefLoading() {
  return (
    <div style={{ padding: '60px 20px', textAlign: 'center' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '20px',
        fontStyle: 'italic',
        color: '#666',
      }}>Fetching your brief…</div>
    </div>
  )
}

// ─── No brief ─────────────────────────────────────────────────────────────────

function NoBrief({ profile }: { profile: Profile | null }) {
  return (
    <div style={{ padding: '28px 20px' }}>
      <div style={{
        border: '1px solid #2A2A2A',
        borderTop: '2px solid #C8A45A',
        padding: '24px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '2px',
          color: '#C8A45A',
          marginBottom: '14px',
        }}>TODAY'S BRIEF IS BEING PREPARED</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '20px',
          fontStyle: 'italic',
          color: '#F5F1EA',
          marginBottom: '12px',
          lineHeight: '1.4',
        }}>Your first brief arrives tomorrow at 6:45 AM.</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '16px',
          color: '#888',
          lineHeight: '1.7',
          marginBottom: '20px',
        }}>
          Every morning, Morning Brief fetches the day's news and rewrites it in plain, warm English — no noise, no spin. Tailored to {profile?.city_current || 'your city'} and your interests.
        </div>
        {[
          `📍 Local news for ${profile?.city_current || 'your city'}`,
          '🌍 World affairs & India politics',
          '💼 Markets & business',
          `📖 In ${(profile?.edition_preference as string) === '5min' ? '5-minute' : (profile?.edition_preference as string) === 'deep' ? 'deep dive' : '10-minute'} depth`,
        ].map(item => (
          <div key={item} style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '16px',
            color: '#888',
            padding: '10px 0',
            borderBottom: '1px solid #222',
            lineHeight: '1.4',
          }}>{item}</div>
        ))}
      </div>
    </div>
  )
}

// ─── Brief renderer ───────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'world',   label: 'World',   icon: '🌍' },
  { id: 'india',   label: 'India',   icon: '🇮🇳' },
  { id: 'markets', label: 'Markets', icon: '📈' },
  { id: 'sport',   label: 'Sport',   icon: '🏏' },
  { id: 'culture', label: 'Culture', icon: '🎭' },
]

function SidebarNav({ activeSection }: { activeSection: string }) {
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
      background: '#111',
      borderRight: '1px solid #2A2A2A',
    }}>
      {SECTIONS.map(({ id, label, icon }) => {
        const isActive = activeSection === id
        return (
          <button
            key={id}
            onClick={() => scrollTo(id)}
            style={{
              background: 'none',
              border: 'none',
              borderLeft: isActive ? '2px solid #C8A45A' : '2px solid transparent',
              padding: '10px 12px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              width: '52px',
            }}
          >
            <span style={{ fontSize: '16px', lineHeight: '1' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '7px',
              letterSpacing: '0.5px',
              color: isActive ? '#C8A45A' : '#888',
              lineHeight: '1',
            }}>{label.toUpperCase()}</span>
          </button>
        )
      })}
    </div>
  )
}

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
  const [activeSection, setActiveSection] = useState('world')

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...SECTIONS].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 120) {
          setActiveSection(id)
          return
        }
      }
      setActiveSection('world')
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Builds the unique key for a story so we know if it's saved
  const keyFor = (section: string, index: number) =>
    `${todayISO}-${activeEdition}-${section}-${index}`

  return (
    <div style={{ position: 'relative' }}>
      <SidebarNav activeSection={activeSection} />

      {/* Content offset for sidebar */}
      <div style={{ padding: '0 20px 40px 68px' }}>

        <div id="world" style={{ paddingTop: '32px' }}>
          <SectionLabel>🌍 World</SectionLabel>
          {brief.world.map((story, i) => (
            <StoryCard
              key={i}
              story={story}
              isSaved={savedKeys.has(keyFor('world', i))}
              onToggle={() => onToggle('world', i, story)}
            />
          ))}
        </div>

        <div id="india" style={{ paddingTop: '40px' }}>
          <SectionLabel>🇮🇳 India</SectionLabel>
          {brief.india.map((story, i) => (
            <StoryCard
              key={i}
              story={story}
              isSaved={savedKeys.has(keyFor('india', i))}
              onToggle={() => onToggle('india', i, story)}
            />
          ))}
        </div>

        <div id="markets" style={{ paddingTop: '40px' }}>
          <SectionLabel>📈 Markets</SectionLabel>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px',
            margin: '18px 0',
          }}>
            {brief.markets.indices.map((idx) => (
              <div key={idx.name} style={{
                background: '#1E1E1E',
                border: '1px solid #2A2A2A',
                padding: '14px 16px',
              }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '11px',
                  letterSpacing: '1px',
                  color: '#666',
                  marginBottom: '8px',
                }}>{idx.name}</div>
                <div style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '20px',
                  fontWeight: '700',
                  color: marketColor(idx.change),
                }}>{idx.change}</div>
              </div>
            ))}
          </div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '17px',
            color: '#C0B9AF',
            lineHeight: '1.8',
          }}>{brief.markets.summary}</div>
        </div>

        <div id="sport" style={{ paddingTop: '40px' }}>
          <SectionLabel>🏏 Sport</SectionLabel>
          <StoryCard
            story={brief.sport}
            isSaved={savedKeys.has(keyFor('sport', 0))}
            onToggle={() => onToggle('sport', 0, brief.sport)}
          />
        </div>

        <div id="culture" style={{ paddingTop: '40px' }}>
          <SectionLabel>🎭 Culture</SectionLabel>
          <StoryCard
            story={brief.culture}
            isSaved={savedKeys.has(keyFor('culture', 0))}
            onToggle={() => onToggle('culture', 0, brief.culture)}
          />
        </div>

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
  const [activeEdition, setActiveEdition] = useState<'5min' | '10min' | 'deep'>('5min')

  // Bookmark state
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
        const pref = profileData.edition_preference as string
        if (pref === '5min' || pref === '10min' || pref === 'deep') {
          setActiveEdition(pref as '5min' | '10min' | 'deep')
        }
      }

      // ── Load the brief ──────────────────────────────────────────────
      // Personalised users get their custom brief first; if none exists
      // yet, we fall back to the shared standard brief so nothing breaks.
      const isPersonalised = profileData?.brief_type === 'personalised'
      const loadedBriefs: Record<string, BriefContent> = {}

      if (isPersonalised) {
        const { data: personalised } = await supabase
          .from('personalised_briefs')
          .select('edition, content')
          .eq('user_id', user.id)
          .eq('date', todayISO)
          .eq('status', 'ready')
        if (personalised && personalised.length > 0) {
          personalised.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      // Fallback to standard briefs if no personalised brief was found
      if (Object.keys(loadedBriefs).length === 0) {
        const { data: standard } = await supabase
          .from('briefs')
          .select('edition, content')
          .eq('date', todayISO)
          .eq('status', 'ready')
        if (standard && standard.length > 0) {
          standard.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      setBriefs(loadedBriefs)

      // ── Load which stories this user has already saved today ─────────
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

  // ── Save / unsave a story ──────────────────────────────────────────
  const toggleBookmark = async (section: string, index: number, story: Story) => {
    if (!userId) {
      alert('Your session was not found — please log in again.')
      return
    }
    const key = `${todayISO}-${activeEdition}-${section}-${index}`
    const currentlySaved = savedKeys.has(key)

    // Update the screen immediately (optimistic)
    setSavedKeys(prev => {
      const next = new Set(prev)
      if (currentlySaved) next.delete(key)
      else next.add(key)
      return next
    })

    // Undo the screen change if the database call fails
    const revert = () => {
      setSavedKeys(prev => {
        const next = new Set(prev)
        if (currentlySaved) next.add(key)
        else next.delete(key)
        return next
      })
    }

    if (currentlySaved) {
      const { error } = await supabase
        .from('bookmarks')
        .delete()
        .eq('user_id', userId)
        .eq('brief_date', todayISO)
        .eq('edition', activeEdition)
        .eq('section', section)
        .eq('story_index', index)
      if (error) {
        revert()
        alert('Could not remove bookmark: ' + error.message)
      }
    } else {
      const { error } = await supabase
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
        } else {
          const { error } = await supabase
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
        })
      if (error) {
        revert()
        alert('Could not save bookmark: ' + error.message)
      }
    }
  }

  const activeBrief = briefs[activeEdition]
  const hasBriefs = Object.keys(briefs).length > 0

  return (
    <div style={{ minHeight: '100vh', background: '#1A1A1A' }}>

      {/* Header — matching index page brand treatment */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '2px solid #C8A45A',
        padding: '20px 20px 16px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
          <Link href="/home" style={{
            color: '#888', textDecoration: 'none',
            fontSize: '20px', marginRight: '16px',
            minHeight: '44px', display: 'flex', alignItems: 'center',
          }}>←</Link>
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '28px',
              fontWeight: '900',
              color: '#F5F1EA',
              lineHeight: '1',
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '28px',
              fontWeight: '900',
              color: '#C8A45A',
              lineHeight: '1',
            }}>Brief</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '1px',
              color: '#888',
              lineHeight: '1.6',
            }}>{today.toUpperCase()}</div>
            {profile && (
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '9px',
                letterSpacing: '1px',
                color: '#777',
              }}>{profile.city_current?.toUpperCase()}</div>
            )}
          </div>
        </div>

        {/* Edition tabs */}
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
      <div style={{ paddingBottom: '80px' }}>
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
        background: '#111',
        borderTop: '1px solid #2A2A2A',
        display: 'flex',
        height: '60px',
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/bookmarks', label: 'Saved', icon: '★', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '2px', textDecoration: 'none', minHeight: '60px',
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#777' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px', letterSpacing: '1px',
              color: active ? '#C8A45A' : '#777',
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
}
