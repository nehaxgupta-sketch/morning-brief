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
  return '#888'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "'DM Mono', monospace",
      fontSize: '8px',
      letterSpacing: '3px',
      color: '#C8A45A',
      marginBottom: '12px',
      paddingBottom: '8px',
      borderBottom: '1px solid rgba(200,164,90,0.2)',
    }}>{children}</div>
  )
}

function StoryCard({ story, index }: { story: Story; index?: number }) {
  return (
    <div style={{
      padding: '16px 0',
      borderBottom: '1px solid #EAE5DC',
    }}>
      {index !== undefined && (
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '8px',
          letterSpacing: '2px',
          color: '#C8A45A',
          marginBottom: '6px',
        }}>{String(index + 1).padStart(2, '0')}</div>
      )}
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '16px',
        fontWeight: '700',
        color: '#1A1A1A',
        lineHeight: '1.35',
        marginBottom: '8px',
      }}>{story.headline}</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '13px',
        color: '#555',
        lineHeight: '1.65',
        marginBottom: '8px',
      }}>{story.body}</div>
      <div style={{
        fontFamily: "'DM Mono', monospace",
        fontSize: '8px',
        letterSpacing: '1px',
        color: '#AAA',
      }}>via {story.source}</div>
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
        padding: '10px 0',
        fontFamily: "'DM Mono', monospace",
        fontSize: '8px',
        letterSpacing: '2px',
        color: active ? '#C8A45A' : '#666',
        cursor: 'pointer',
        transition: 'color 0.15s',
      }}
    >{label}</button>
  )
}

// ─── Loading state ────────────────────────────────────────────────────────────

function BriefLoading() {
  return (
    <div style={{ padding: '40px 20px', textAlign: 'center' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '18px',
        fontStyle: 'italic',
        color: '#888',
        marginBottom: '8px',
      }}>Fetching your brief…</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '13px',
        color: '#AAA',
      }}>This only takes a moment.</div>
    </div>
  )
}

// ─── No brief state ───────────────────────────────────────────────────────────

function NoBrief({ profile }: { profile: Profile | null }) {
  return (
    <div style={{ padding: '24px 20px' }}>
      <div style={{
        background: '#FDFCF9',
        border: '1px solid #E2DBD0',
        borderTop: '2px solid #C8A45A',
        padding: '20px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '8px',
          letterSpacing: '2px',
          color: '#C8A45A',
          marginBottom: '12px',
        }}>TODAY'S BRIEF IS BEING PREPARED</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '16px',
          fontStyle: 'italic',
          color: '#333',
          marginBottom: '10px',
          lineHeight: '1.4',
        }}>Your first brief arrives tomorrow at 6:45 AM.</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '13px',
          color: '#777',
          lineHeight: '1.6',
          marginBottom: '16px',
        }}>
          Every morning, Morning Brief fetches the day's news and rewrites it in plain, warm English — no noise, no spin. Tailored to {profile?.city_current || 'your city'} and your interests.
        </div>
        {[
          `📍 Local news for ${profile?.city_current || 'your city'}`,
          '🌍 World affairs & India politics',
          `💼 Markets & business`,
          `📖 In ${(profile?.edition_preference as string) === '5min' ? '5-minute' : (profile?.edition_preference as string) === 'deep' ? 'deep dive' : '10-minute'} depth`,
        ].map(item => (
          <div key={item} style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            color: '#444',
            padding: '7px 0',
            borderBottom: '1px solid #F0EDE6',
            lineHeight: '1.4',
          }}>{item}</div>
        ))}
      </div>
    </div>
  )
}

// ─── Main brief renderer ──────────────────────────────────────────────────────

function BriefRenderer({ brief }: { brief: BriefContent }) {
  return (
    <div style={{ padding: '0 20px 32px' }}>

      {/* World */}
      <div style={{ paddingTop: '24px', marginBottom: '8px' }}>
        <SectionLabel>🌍 WORLD</SectionLabel>
        {brief.world.map((story, i) => (
          <StoryCard key={i} story={story} index={i} />
        ))}
      </div>

      {/* India */}
      <div style={{ paddingTop: '24px', marginBottom: '8px' }}>
        <SectionLabel>🇮🇳 INDIA</SectionLabel>
        {brief.india.map((story, i) => (
          <StoryCard key={i} story={story} index={i} />
        ))}
      </div>

      {/* Markets */}
      <div style={{ paddingTop: '24px', marginBottom: '8px' }}>
        <SectionLabel>📈 MARKETS</SectionLabel>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '8px',
          marginBottom: '14px',
        }}>
          {brief.markets.indices.map((idx) => (
            <div key={idx.name} style={{
              background: '#FDFCF9',
              border: '1px solid #E2DBD0',
              padding: '10px 12px',
            }}>
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '8px',
                letterSpacing: '1px',
                color: '#888',
                marginBottom: '4px',
              }}>{idx.name}</div>
              <div style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '15px',
                fontWeight: '700',
                color: marketColor(idx.change),
              }}>{idx.change}</div>
            </div>
          ))}
        </div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '13px',
          color: '#555',
          lineHeight: '1.65',
        }}>{brief.markets.summary}</div>
      </div>

      {/* Sport */}
      <div style={{ paddingTop: '24px', marginBottom: '8px' }}>
        <SectionLabel>🏏 SPORT</SectionLabel>
        <StoryCard story={brief.sport} />
      </div>

      {/* Culture */}
      <div style={{ paddingTop: '24px' }}>
        <SectionLabel>🎭 CULTURE</SectionLabel>
        <StoryCard story={brief.culture} />
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

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })

  const todayISO = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      // Auth check
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      // Load profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(profileData)

      // Set default edition from profile preference
      if (profileData?.edition_preference) {
        const pref = profileData.edition_preference
        if (pref === '5min' || pref === '10min' || pref === 'deep') {
          setActiveEdition(pref)
        }
      }

      // Load today's briefs
      const { data: briefData } = await supabase
        .from('briefs')
        .select('edition, content')
        .eq('date', todayISO)
        .eq('status', 'ready')

      if (briefData && briefData.length > 0) {
        const mapped: Record<string, BriefContent> = {}
        briefData.forEach((row: any) => {
          mapped[row.edition] = row.content
        })
        setBriefs(mapped)
      }

      setLoading(false)
    }
    load()
  }, [])

  const activeBrief = briefs[activeEdition]
  const hasBriefs = Object.keys(briefs).length > 0

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>

      {/* Header */}
      <div style={{
        background: '#1A1A1A',
        borderBottom: '3px solid #C8A45A',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '52px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <Link href="/home" style={{
          color: '#888', textDecoration: 'none',
          fontSize: '18px', minHeight: '44px',
          display: 'flex', alignItems: 'center',
        }}>←</Link>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '18px',
          fontWeight: '700',
          fontStyle: 'italic',
          color: '#C8A45A',
        }}>Morning Brief</div>
        <div style={{ width: '44px' }} />
      </div>

      {/* Masthead */}
      <div style={{
        background: '#1A1A1A',
        padding: '12px 20px 14px',
        borderBottom: '1px solid #2A2A2A',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '8px',
          letterSpacing: '2px',
          color: '#555',
          marginBottom: '2px',
        }}>{today.toUpperCase()}</div>
        {profile && (
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '8px',
            letterSpacing: '1px',
            color: '#444',
          }}>
            {profile.city_current?.toUpperCase()} · {profile.profession?.toUpperCase()}
          </div>
        )}
      </div>

      {/* Edition tabs — only show if briefs exist */}
      {hasBriefs && (
        <div style={{
          background: '#1A1A1A',
          borderBottom: '1px solid #2A2A2A',
          display: 'flex',
          padding: '0 20px',
        }}>
          {(['5min', '10min', 'deep'] as const).map(ed => (
            briefs[ed] ? (
              <EditionTab
                key={ed}
                label={editionLabel(ed)}
                active={activeEdition === ed}
                onClick={() => setActiveEdition(ed)}
              />
            ) : null
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ paddingBottom: '80px' }}>
        {loading ? (
          <BriefLoading />
        ) : hasBriefs && activeBrief ? (
          <BriefRenderer brief={activeBrief} />
        ) : (
          <NoBrief profile={profile} />
        )}
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        background: '#1A1A1A',
        borderTop: '1px solid #2A2A2A',
        display: 'flex',
        height: '60px',
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: true },
          { href: '/habits', label: 'Habits', icon: '◎', active: false },
          { href: '/bookmarks', label: 'Saved', icon: '◈', active: false },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '2px', textDecoration: 'none', minHeight: '60px',
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#444' }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '8px', letterSpacing: '1px',
              color: active ? '#C8A45A' : '#444',
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>

    </div>
  )
}
