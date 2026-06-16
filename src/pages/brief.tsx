// src/pages/brief.tsx
//
// Sprint 8 — three editions, three render paths.
// - The Brief (5min): micro-item list, no closer, no lens body
// - The Daily (10min): full-structure stories with 5 labelled fields, closer
// - The Editorial (deep): three patterns + long read + watching + signature
// Personalised users see a quick_personal_relevance banner at the top of
// The Daily and The Editorial.
// Backward compatible: legacy briefs without new fields fall back gracefully.

import { useEffect, useState, createContext, useContext } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase, Profile } from '@/lib/supabase'
import { listSavedUrls, saveStory, unsaveStory } from '@/lib/saved'

const C = {
  bg: '#0E0E0E', surface: '#161616', surface2: '#1E1E1E',
  border: '#262626', borderHi: '#3A3A3A',
  gold: '#C8A45A', goldSoft: 'rgba(200,164,90,0.10)', goldBorder: 'rgba(200,164,90,0.40)',
  text: '#F5F1EA', textSoft: '#CFC6B8', textMute: '#8E867B', textDim: '#5E574D',
  ok: '#5FB87E', err: '#E76161',
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface MicroStory {
  headline: string
  what_happened?: string
  why_it_matters?: string
  source: string
  source_url?: string
  body?: string  // legacy fallback
}

interface FullStory {
  headline: string
  facts?: string
  background?: string
  why_it_matters?: string
  what_happens_next?: string
  analysis?: string
  source: string
  source_url?: string
  body?: string  // legacy fallback
}

interface MarketIndex { name: string; change: string }
interface Closer {
  headlines_to_remember: string[]
  things_to_watch: string[]
  conversation_insight: string
}
interface PersonalSection {
  id: string; label: string; icon: string; kind: 'list'; stories: any[]
}
interface Pattern { title: string; body: string; stories_connected?: string[] }
interface LongRead {
  title: string; body: string
  candidate_themes?: string[]
  personalised_theme_hint?: string
}
interface WatchItem { title: string; body: string }
interface Signature {
  one_number?: { value: string; context: string }
  one_chart?: { title: string; description: string }
  one_quote?: { quote: string; attribution: string; context: string }
}

interface BriefContent {
  edition: string
  date: string
  // Quick / Daily:
  major_events?: any[]
  world?: any[]
  india?: any[]
  topics?: MicroStory[]
  business?: any[]
  technology?: any[]
  climate_health?: any[]
  politics?: any[]
  markets_news?: any[]
  markets?: { summary: string; indices: MarketIndex[] }
  sport?: any[]
  culture?: any[]
  // Editorial:
  three_patterns?: Pattern[]
  long_read?: LongRead
  watching_this_week?: WatchItem[]
  signature?: Signature
  // Shared:
  closer?: Closer
  personal_sections?: PersonalSection[]
  quick_personal_relevance?: string
  // Legacy:
  bengaluru?: any[]
  delhi?: any[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function editionDisplay(edition: string) {
  if (edition === '5min') return 'The Brief'
  if (edition === '10min') return 'The Daily'
  if (edition === 'deep') return 'The Editorial'
  return edition
}

// Sprint 14.5: IST-anchored date helper. Briefs are dated by IST (the backend
// uses getISTDate), so the reader must resolve dates in IST too — otherwise a
// user opening late at night could query the wrong calendar day. offsetDays=0
// is today, 1 is yesterday, 2 is the day before.
function istDateISO(offsetDays = 0): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000 - offsetDays * 86400000
  return new Date(istMs).toISOString().slice(0, 10)
}

// Relative label for a brief date, for the header ("" when it's today).
function relativeDateTag(iso: string): string {
  if (iso === istDateISO(0)) return ''
  if (iso === istDateISO(1)) return 'YESTERDAY'
  if (iso === istDateISO(2)) return '2 DAYS AGO'
  return ''
}

function marketColor(change: string) {
  if (change?.startsWith('+')) return C.ok
  if (change?.startsWith('-')) return C.err
  return C.textMute
}

function normaliseEdition(raw: string | undefined | null): '5min' | '10min' | 'deep' {
  const p = raw === 'ultra' ? '5min' : raw
  if (p === '5min' || p === '10min' || p === 'deep') return p
  return '10min'
}

function isFullStory(s: any): boolean {
  return !!(s && (s.facts || s.background || s.what_happens_next || s.analysis))
}

// ─── Section catalogue ──────────────────────────────────────────────────────

type SectionKind = 'list' | 'single' | 'markets'
interface SectionDef { id: string; label: string; icon: string; kind: SectionKind }

const DAILY_SECTIONS: SectionDef[] = [
  { id: 'major_events',   label: 'Major events', icon: '🔥', kind: 'list' },
  { id: 'world',          label: 'World',        icon: '🌍', kind: 'list' },
  { id: 'india',          label: 'India',        icon: '🇮🇳', kind: 'list' },
  { id: 'politics',       label: 'Politics & Policy', icon: '🏛️', kind: 'list' },
  { id: 'business',       label: 'Business',     icon: '💼', kind: 'list' },
  { id: 'markets',        label: 'Markets',      icon: '📈', kind: 'markets' },
  { id: 'markets_news',   label: 'Markets & Money', icon: '💹', kind: 'list' },
  { id: 'technology',     label: 'Technology',   icon: '💻', kind: 'list' },
  { id: 'climate_health', label: 'Climate & Health', icon: '🌱', kind: 'list' },
  { id: 'sport',          label: 'Sport',        icon: '🏏', kind: 'list' },
  { id: 'culture',        label: 'Culture',      icon: '🎭', kind: 'list' },
  // Legacy — hidden when empty:
  { id: 'bengaluru',      label: 'Bengaluru',    icon: '🏙️', kind: 'list' },
  { id: 'delhi',          label: 'Delhi',        icon: '🏛️', kind: 'list' },
]

const QUICK_SECTIONS: SectionDef[] = [
  { id: 'major_events',   label: 'Major events', icon: '🔥', kind: 'list' },
  { id: 'world',          label: 'World',        icon: '🌍', kind: 'list' },
  { id: 'india',          label: 'India',        icon: '🇮🇳', kind: 'list' },
  { id: 'topics',         label: 'Topics',       icon: '📰', kind: 'list' },
]

function sectionHasContent(section: SectionDef, brief: BriefContent): boolean {
  if (section.kind === 'list') {
    const arr = (brief as any)[section.id]
    return Array.isArray(arr) && arr.length > 0
  }
  if (section.kind === 'single') {
    const s = (brief as any)[section.id]
    return !!(s && s.headline)
  }
  if (section.kind === 'markets') {
    return !!(brief.markets && (brief.markets.summary || (brief.markets.indices?.length ?? 0) > 0))
  }
  return false
}

// ─── Components ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: '30px', fontWeight: 800, color: C.gold,
      marginBottom: '6px', display: 'flex', alignItems: 'center',
      gap: '12px', lineHeight: 1.15,
    }}>{children}</div>
  )
}

function SourceLine({ source, sourceUrl }: { source: string; sourceUrl?: string }) {
  const s: React.CSSProperties = {
    fontFamily: "'DM Mono', monospace", fontSize: '11px',
    letterSpacing: '1.5px', color: C.textMute, textDecoration: 'none',
  }
  if (sourceUrl) {
    return <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={s}>via {source} ↗</a>
  }
  return <div style={s}>via {source}</div>
}

// Sprint 13: bookmarks → Follow a Story. The pill has four states; the gold
// "nudge" treatment appears only on high-confidence storylines (detection-
// driven prompt to follow).
// Sprint 13.3 (locked with Neha): EVERY story shows the Follow pill — the
// user chooses what to track. Short-arc stories simply go quiet and the
// dormancy/conclusion lifecycle retires them. Set to false to show pills
// only on pipeline-detected storylines.
const SHOW_FOLLOW_ON_UNMAPPED = true

type FollowState = 'hidden' | 'none' | 'following' | 'busy' | 'declined' 

function FollowButton({ state, nudge, onToggle }: {
  state: FollowState; nudge: boolean; onToggle: () => void
}) {
  if (state === 'hidden') return null
  const isNudge = nudge && state === 'none' 
  const label =
    state === 'following' ? 'FOLLOWING ✓'
    : state === 'busy' ? 'FOLLOWING…'
    : state === 'declined' ? 'ONE-OFF STORY'
    : isNudge ? '📌 FOLLOW THIS STORY'
    : 'FOLLOW'
  return (
    <button onClick={onToggle} disabled={state === 'busy' || state === 'declined'} style={{
      background: isNudge ? C.gold : 'none',
      border: isNudge ? 'none' : `1px solid ${state === 'following' ? 'rgba(200,164,90,0.45)' : C.border}`,
      borderRadius: '2px',
      cursor: state === 'busy' || state === 'declined' ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '8px 12px', minHeight: '40px', whiteSpace: 'nowrap',
      fontFamily: "'DM Mono', monospace", fontSize: '10px',
      letterSpacing: '1.5px', fontWeight: isNudge ? 700 : 400,
      color: isNudge ? '#1A1A1A'
        : state === 'following' ? C.gold
        : state === 'declined' ? C.textDim
        : C.textMute,
    }} title={state === 'following' ? 'Unfollow this story' : 'Follow this story for daily updates and full context'}>
      {label}
    </button>
  )
}

// The follow API handed down from BriefPage to renderers and cards.
// Sprint 14.6: save-a-story. Provided once at the top of the reader so the
// per-story button reads/writes shared state without prop-threading through
// every section/card layer.
type SaveApi = { isSaved: (story: any) => boolean; toggle: (story: any) => void }
const SavedContext = createContext<SaveApi | null>(null)

function SaveButton({ story }: { story: any }) {
  const api = useContext(SavedContext)
  const url = story?.source_url || ''
  if (!api || !url) return null
  const saved = api.isSaved(story)
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.toggle(story) }}
      aria-label={saved ? 'Saved — tap to remove' : 'Save story'}
      style={{
        background: 'none',
        border: `1px solid ${saved ? C.goldBorder : C.border}`,
        color: saved ? C.gold : C.textMute,
        borderRadius: '2px',
        padding: '6px 10px',
        cursor: 'pointer',
        fontFamily: "'DM Mono', monospace",
        fontSize: '10px',
        letterSpacing: '1px',
        minHeight: '36px',
        whiteSpace: 'nowrap',
      }}
    >{saved ? '★ SAVED' : '☆ SAVE'}</button>
  )
}

interface FollowApi {
  stateFor: (story: any) => FollowState
  nudgeFor: (story: any) => boolean
  toggle: (story: any) => void
}

function MicroCard({ story, follow }: {
  story: MicroStory; follow: FollowApi
}) {
  const what = story.what_happened || story.body || ''
  const why = story.why_it_matters || ''
  return (
    <div style={{ padding: '20px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '20px', fontWeight: 700, color: C.text,
        lineHeight: 1.35, marginBottom: '10px',
      }}>{story.headline}</div>
      {what && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
          color: C.textSoft, lineHeight: 1.65,
          marginBottom: why ? '8px' : '14px',
        }}>{what}</div>
      )}
      {why && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
          color: C.textMute, lineHeight: 1.6, marginBottom: '14px',
        }}>
          <span style={{
            color: C.gold, marginRight: '8px',
            fontFamily: "'DM Mono', monospace", fontSize: '10px',
            letterSpacing: '1.5px',
          }}>WHY IT MATTERS</span>
          {why}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SourceLine source={story.source} sourceUrl={story.source_url} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SaveButton story={story} />
          <FollowButton state={follow.stateFor(story)} nudge={follow.nudgeFor(story)} onToggle={() => follow.toggle(story)} />
        </div>
      </div>
    </div>
  )
}

function FullCard({ story, follow }: {
  story: FullStory; follow: FollowApi
}) {
  const fields: [string, string | undefined][] = [
    ['FACTS', story.facts],
    ['BACKGROUND', story.background],
    ['WHY IT MATTERS', story.why_it_matters],
    ['WHAT HAPPENS NEXT', story.what_happens_next],
    ['ANALYSIS', story.analysis],
  ]
  const hasNew = isFullStory(story)
  return (
    <div style={{ padding: '24px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '23px', fontWeight: 700, color: C.text,
        lineHeight: 1.32, marginBottom: '16px',
      }}>{story.headline}</div>

      {hasNew ? (
        <div style={{ marginBottom: '16px' }}>
          {fields.map(([label, val]) => val ? (
            <div key={label} style={{ marginBottom: '14px' }}>
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: C.gold, marginBottom: '6px',
              }}>{label}</div>
              <div style={{
                fontFamily: "'DM Sans', sans-serif", fontSize: '17px',
                color: C.textSoft, lineHeight: 1.75,
              }}>{val}</div>
            </div>
          ) : null)}
        </div>
      ) : (
        story.body && (
          <div style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: '17px',
            color: C.textSoft, lineHeight: 1.75, marginBottom: '16px',
          }}>{story.body}</div>
        )
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SourceLine source={story.source} sourceUrl={story.source_url} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SaveButton story={story} />
          <FollowButton state={follow.stateFor(story)} nudge={follow.nudgeFor(story)} onToggle={() => follow.toggle(story)} />
        </div>
      </div>
    </div>
  )
}

function EditionTab({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1, background: 'none', border: 'none',
      borderBottom: active ? `2px solid ${C.gold}` : '2px solid transparent',
      padding: '14px 4px',
      fontFamily: "'DM Mono', monospace", fontSize: '11px',
      letterSpacing: '2px', color: active ? C.gold : C.textMute,
      cursor: 'pointer', transition: 'color 0.15s',
    }}>{label}</button>
  )
}

function PersonalRelevance({ text }: { text: string }) {
  if (!text) return null
  return (
    <div style={{
      background: C.goldSoft, border: `1px solid ${C.goldBorder}`,
      borderLeft: `3px solid ${C.gold}`,
      padding: '18px 20px', marginBottom: '24px', marginTop: '12px',
    }}>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: '10px',
        letterSpacing: '2px', color: C.gold, marginBottom: '10px',
      }}>FOR YOU TODAY</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
        color: C.textSoft, lineHeight: 1.65,
      }}>{text}</div>
    </div>
  )
}

function BriefLoading() {
  return (
    <div style={{ padding: '80px 20px', textAlign: 'center' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: '22px', fontStyle: 'italic', color: C.textMute,
      }}>Fetching your brief…</div>
    </div>
  )
}

function NoBrief({ profile }: { profile: Profile | null }) {
  const depthLabel = editionDisplay(normaliseEdition(profile?.edition_preference as string))
  return (
    <div style={{ padding: '32px 20px' }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderTop: `3px solid ${C.gold}`, padding: '28px 24px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '11px',
          letterSpacing: '2px', color: C.gold, marginBottom: '18px',
        }}>TODAY'S BRIEF IS BEING PREPARED</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif", fontSize: '24px',
          fontStyle: 'italic', color: C.text, marginBottom: '16px', lineHeight: 1.4,
        }}>Your first brief arrives tomorrow at 6:45 AM.</div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
          color: C.textSoft, lineHeight: 1.7, marginBottom: '24px',
        }}>
          Every morning, Morning Brief fetches the day's news from trusted publishers
          and rewrites it in plain, warm English — no noise, no spin.
          Your default is {depthLabel}.
        </div>
        {[
          '🔥 Major events worth tracking',
          '🌍 World affairs & India politics',
          '📈 Markets, business, technology',
          '📖 Three editions: The Brief, The Daily, The Editorial',
        ].map(item => (
          <div key={item} style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
            color: C.textSoft, padding: '12px 0',
            borderBottom: `1px solid ${C.border}`, lineHeight: 1.5,
          }}>{item}</div>
        ))}
      </div>
    </div>
  )
}

function SidebarNav({ sections, activeSection }: {
  sections: SectionDef[]; activeSection: string
}) {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div style={{
      position: 'fixed', left: 0, top: '50%',
      transform: 'translateY(-50%)', zIndex: 20,
      display: 'flex', flexDirection: 'column', gap: '2px',
      padding: '8px 0', background: C.surface,
      borderRight: `1px solid ${C.border}`,
      maxHeight: '90vh', overflowY: 'auto',
    }}>
      {sections.map(({ id, label, icon }) => {
        const isActive = activeSection === id
        return (
          <button key={id} onClick={() => scrollTo(id)} style={{
            background: 'none', border: 'none',
            borderLeft: isActive ? `2px solid ${C.gold}` : '2px solid transparent',
            padding: '10px', cursor: 'pointer',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: '4px', width: '56px',
          }}>
            <span style={{ fontSize: '16px', lineHeight: 1 }}>{icon}</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '8px',
              letterSpacing: '0.6px',
              color: isActive ? C.gold : C.textMute,
              lineHeight: 1, textAlign: 'center',
            }}>{label.toUpperCase()}</span>
          </button>
        )
      })}
    </div>
  )
}

function CloserBlock({ closer }: { closer: Closer }) {
  return (
    <div id="closer" style={{ paddingTop: '64px', marginTop: '28px', borderTop: `1px solid ${C.border}` }}>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: '11px',
        letterSpacing: '2.5px', color: C.gold, marginBottom: '28px',
      }}>BEFORE YOU CLOSE</div>

      <div style={{ marginBottom: '40px' }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px', fontWeight: 700, color: C.text,
          marginBottom: '18px', lineHeight: 1.3,
        }}>Headlines to remember today</div>
        {closer.headlines_to_remember.map((line, i) => (
          <div key={i} style={{
            display: 'flex', gap: '14px', padding: '12px 0',
            borderBottom: `1px solid ${C.border}`,
            fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
            color: C.textSoft, lineHeight: 1.6,
          }}>
            <span style={{ color: C.gold, fontWeight: 700, minWidth: '22px' }}>{i + 1}.</span>
            <span>{line}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: '40px' }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '22px', fontWeight: 700, color: C.text,
          marginBottom: '18px', lineHeight: 1.3,
        }}>Things to watch this week</div>
        {closer.things_to_watch.map((line, i) => (
          <div key={i} style={{
            padding: '12px 0', borderBottom: `1px solid ${C.border}`,
            fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
            color: C.textSoft, lineHeight: 1.65,
          }}>
            <span style={{ color: C.gold, marginRight: '10px' }}>→</span>
            {line}
          </div>
        ))}
      </div>

      <div style={{
        background: C.surface2, border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${C.gold}`, padding: '24px', marginBottom: '24px',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '10px',
          letterSpacing: '2px', color: C.gold, marginBottom: '14px',
        }}>ONE INSIGHT WORTH SHARING</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif", fontSize: '19px',
          fontStyle: 'italic', color: C.text, lineHeight: 1.6,
        }}>{closer.conversation_insight}</div>
      </div>
    </div>
  )
}

// ─── Renderer: The Brief ────────────────────────────────────────────────────

function QuickRenderer({
  brief, follow,
}: {
  brief: BriefContent; follow: FollowApi
}) {
  const visibleSections = QUICK_SECTIONS.filter(s => sectionHasContent(s, brief))
  const personalSections = brief.personal_sections ?? []

  const navSections: SectionDef[] = [...visibleSections]
  if (personalSections.length > 0) {
    const idx = navSections.findIndex(s => s.id === 'india')
    const insertAt = idx >= 0 ? idx + 1 : navSections.length
    navSections.splice(insertAt, 0, ...personalSections.map(p => ({
      id: p.id, label: p.label, icon: p.icon, kind: 'list' as const,
    })))
  }

  const [activeSection, setActiveSection] = useState(navSections[0]?.id ?? 'world')

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...navSections].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 140) { setActiveSection(id); return }
      }
      if (navSections[0]) setActiveSection(navSections[0].id)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief])

  type Item = { kind: 'std'; section: SectionDef } | { kind: 'pers'; section: PersonalSection }
  const items: Item[] = []
  for (const section of visibleSections) {
    items.push({ kind: 'std', section })
    if (section.id === 'india' && personalSections.length > 0) {
      for (const p of personalSections) items.push({ kind: 'pers', section: p })
    }
  }
  if (!visibleSections.some(s => s.id === 'india') && personalSections.length > 0) {
    items.unshift(...personalSections.map(p => ({ kind: 'pers' as const, section: p })))
  }

  return (
    <div style={{ position: 'relative' }}>
      <SidebarNav sections={navSections} activeSection={activeSection} />
      <div style={{ padding: '0 20px 40px 72px' }}>
        {items.map((item, idx) => {
          if (item.kind === 'pers') {
            const p = item.section
            return (
              <div key={p.id} id={p.id} style={{ paddingTop: idx === 0 ? '36px' : '44px' }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '2px', color: C.gold, marginBottom: '4px',
                }}>FOR YOU</div>
                <SectionLabel>{p.icon} {p.label}</SectionLabel>
                {(p.stories as MicroStory[]).map((story, i) => (
                  <MicroCard key={i} story={story} follow={follow} />
                ))}
              </div>
            )
          }
          const section = item.section
          const stories = (brief as any)[section.id] as MicroStory[]
          return (
            <div key={section.id} id={section.id} style={{ paddingTop: idx === 0 ? '36px' : '44px' }}>
              <SectionLabel>{section.icon} {section.label}</SectionLabel>
              {stories.map((story, i) => (
                <MicroCard key={i} story={story} follow={follow} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Renderer: The Daily ────────────────────────────────────────────────────

function DeskFeatureCard({ deskSlug, deskName, feature }: {
  deskSlug: string; deskName: string; feature: any
}) {
  return (
    <div style={{ padding: '20px 20px 0' }}>
      <Link href={`/desk/${deskSlug}`} style={{ textDecoration: 'none', display: 'block' }}>
        <div style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderLeft: `3px solid ${C.gold}`,
          padding: '18px 20px',
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '10px',
            letterSpacing: '1.5px', color: C.gold, marginBottom: '10px',
          }}>FROM YOUR {deskName.toUpperCase()} DESK</div>
          {feature?.kind && (
            <span style={{
              display: 'inline-block', fontFamily: "'DM Mono', monospace",
              fontSize: '9px', letterSpacing: '1.5px', color: C.textMute,
              border: `1px solid ${C.border}`, borderRadius: '2px',
              padding: '3px 7px', marginBottom: '10px',
            }}>{String(feature.kind).toUpperCase()}</span>
          )}
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '19px', fontWeight: 700, color: C.text,
            lineHeight: 1.35, marginBottom: '8px',
          }}>{feature?.headline || ''}</div>
          {feature?.body && (
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textSoft, lineHeight: 1.65, marginBottom: '10px',
            }}>{feature.body}</div>
          )}
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '1.5px', color: C.gold,
          }}>READ THE {deskName.toUpperCase()} DESK →</div>
        </div>
      </Link>
    </div>
  )
}

function DailyRenderer({
  brief, follow, isPersonalised,
}: {
  brief: BriefContent; follow: FollowApi
  isPersonalised: boolean
}) {
  const visibleSections = DAILY_SECTIONS.filter(s => sectionHasContent(s, brief))
  const personalSections = brief.personal_sections ?? []

  const navSections: SectionDef[] = [...visibleSections]
  if (personalSections.length > 0) {
    const idx = navSections.findIndex(s => s.id === 'india')
    const insertAt = idx >= 0 ? idx + 1 : navSections.length
    navSections.splice(insertAt, 0, ...personalSections.map(p => ({
      id: p.id, label: p.label, icon: p.icon, kind: 'list' as const,
    })))
  }
  if (brief.closer) {
    navSections.push({ id: 'closer', label: 'Recap', icon: '🌙', kind: 'single' })
  }

  const [activeSection, setActiveSection] = useState(navSections[0]?.id ?? 'major_events')

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...navSections].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 140) { setActiveSection(id); return }
      }
      if (navSections[0]) setActiveSection(navSections[0].id)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief])

  const renderMarkets = () => brief.markets && (
    <>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: '12px', margin: '20px 0',
      }}>
        {brief.markets.indices?.map((idx) => (
          <div key={idx.name} style={{
            background: C.surface2, border: `1px solid ${C.border}`, padding: '16px 18px',
          }}>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '11px',
              letterSpacing: '1.5px', color: C.textMute, marginBottom: '10px',
            }}>{idx.name}</div>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '22px',
              fontWeight: 700, color: marketColor(idx.change),
            }}>{idx.change}</div>
          </div>
        ))}
      </div>
      {brief.markets.summary && (
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '17px',
          color: C.textSoft, lineHeight: 1.75,
        }}>{brief.markets.summary}</div>
      )}
    </>
  )

  type Item = { kind: 'std'; section: SectionDef } | { kind: 'pers'; section: PersonalSection }
  const items: Item[] = []
  for (const section of visibleSections) {
    items.push({ kind: 'std', section })
    if (section.id === 'india' && personalSections.length > 0) {
      for (const p of personalSections) items.push({ kind: 'pers', section: p })
    }
  }
  if (!visibleSections.some(s => s.id === 'india') && personalSections.length > 0) {
    items.unshift(...personalSections.map(p => ({ kind: 'pers' as const, section: p })))
  }

  return (
    <div style={{ position: 'relative' }}>
      <SidebarNav sections={navSections} activeSection={activeSection} />
      <div style={{ padding: '0 20px 40px 72px' }}>
        {isPersonalised && brief.quick_personal_relevance && (
          <PersonalRelevance text={brief.quick_personal_relevance} />
        )}
        {items.map((item, idx) => {
          if (item.kind === 'pers') {
            const p = item.section
            return (
              <div key={p.id} id={p.id} style={{ paddingTop: idx === 0 ? '36px' : '44px' }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '2px', color: C.gold, marginBottom: '4px',
                }}>FOR YOU</div>
                <SectionLabel>{p.icon} {p.label}</SectionLabel>
                {(p.stories as FullStory[]).map((story, i) => (
                  <FullCard key={i} story={story} follow={follow} />
                ))}
              </div>
            )
          }
          const section = item.section
          return (
            <div key={section.id} id={section.id} style={{ paddingTop: idx === 0 ? '36px' : '44px' }}>
              <SectionLabel>{section.icon} {section.label}</SectionLabel>
              {section.kind === 'list' && ((brief as any)[section.id] as FullStory[]).map((story, i) => (
                <FullCard key={i} story={story} follow={follow} />
              ))}
              {section.kind === 'single' && (
                <FullCard story={(brief as any)[section.id] as FullStory} follow={follow} />
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

// ─── Renderer: The Editorial ────────────────────────────────────────────────

function EditorialRenderer({
  brief, isPersonalised,
}: { brief: BriefContent; isPersonalised: boolean }) {
  const navSections: SectionDef[] = []
  if (brief.three_patterns && brief.three_patterns.length > 0) {
    navSections.push({ id: 'three_patterns', label: 'Patterns', icon: '🧭', kind: 'list' })
  }
  if (brief.long_read?.body) {
    navSections.push({ id: 'long_read', label: 'Long read', icon: '📖', kind: 'single' })
  }
  if (brief.watching_this_week && brief.watching_this_week.length > 0) {
    navSections.push({ id: 'watching_this_week', label: 'Watch', icon: '🔭', kind: 'list' })
  }
  if (brief.signature && (brief.signature.one_number || brief.signature.one_chart || brief.signature.one_quote)) {
    navSections.push({ id: 'signature', label: 'Signature', icon: '✦', kind: 'list' })
  }

  const hasNewShape = (brief.three_patterns?.length ?? 0) > 0 || !!brief.long_read?.body

  const [activeSection, setActiveSection] = useState(navSections[0]?.id ?? 'long_read')

  useEffect(() => {
    const handleScroll = () => {
      for (const { id } of [...navSections].reverse()) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 140) { setActiveSection(id); return }
      }
      if (navSections[0]) setActiveSection(navSections[0].id)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief])

  if (!hasNewShape) {
    return (
      <div style={{ padding: '32px 20px' }}>
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`, padding: '24px',
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            letterSpacing: '2px', color: C.gold, marginBottom: '12px',
          }}>EDITORIAL · LEGACY FORMAT</div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
            color: C.textSoft, lineHeight: 1.7,
          }}>
            This brief is in the older format. The Editorial's new structure —
            patterns, long read, watching this week, signature — will appear
            from tomorrow's brief onwards.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <SidebarNav sections={navSections} activeSection={activeSection} />
      <div style={{ padding: '0 20px 40px 72px' }}>
        {isPersonalised && brief.quick_personal_relevance && (
          <PersonalRelevance text={brief.quick_personal_relevance} />
        )}

        {/* Three patterns */}
        {brief.three_patterns && brief.three_patterns.length > 0 && (
          <div id="three_patterns" style={{ paddingTop: '36px' }}>
            <SectionLabel>🧭 Three big patterns</SectionLabel>
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textMute, lineHeight: 1.6, marginBottom: '24px',
            }}>Where today's stories converge.</div>
            {brief.three_patterns.map((p, i) => (
              <div key={i} style={{
                marginBottom: '28px', padding: '24px',
                background: C.surface, border: `1px solid ${C.border}`,
                borderLeft: `3px solid ${C.gold}`,
              }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: '10px',
                  letterSpacing: '2px', color: C.gold, marginBottom: '10px',
                }}>PATTERN {i + 1}</div>
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontSize: '22px', fontWeight: 700, color: C.text,
                  marginBottom: '14px', lineHeight: 1.3,
                }}>{p.title}</div>
                <div style={{
                  fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                  color: C.textSoft, lineHeight: 1.75,
                  marginBottom: p.stories_connected?.length ? '14px' : 0,
                }}>{p.body}</div>
                {p.stories_connected && p.stories_connected.length > 0 && (
                  <div style={{ paddingTop: '14px', borderTop: `1px solid ${C.border}` }}>
                    <div style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      letterSpacing: '1.5px', color: C.textMute, marginBottom: '8px',
                    }}>STORIES CONNECTED</div>
                    {p.stories_connected.map((h, j) => (
                      <div key={j} style={{
                        fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                        color: C.textMute, lineHeight: 1.6,
                        paddingLeft: '14px', position: 'relative',
                      }}>
                        <span style={{ position: 'absolute', left: 0, color: C.gold }}>·</span> {h}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Long read */}
        {brief.long_read?.body && (
          <div id="long_read" style={{ paddingTop: '52px' }}>
            <SectionLabel>📖 The long read</SectionLabel>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '28px', fontWeight: 700, color: C.text,
              lineHeight: 1.25, marginBottom: '12px', marginTop: '20px',
            }}>{brief.long_read.title}</div>
            {brief.long_read.personalised_theme_hint && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: C.gold, marginBottom: '20px',
              }}>FOR YOU · YOU MIGHT ALSO LIKE: {brief.long_read.personalised_theme_hint.toUpperCase()}</div>
            )}
            <div style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '18px',
              color: C.textSoft, lineHeight: 1.85, whiteSpace: 'pre-wrap',
            }}>{brief.long_read.body}</div>
          </div>
        )}

        {/* Watching */}
        {brief.watching_this_week && brief.watching_this_week.length > 0 && (
          <div id="watching_this_week" style={{ paddingTop: '52px' }}>
            <SectionLabel>🔭 Watching this week</SectionLabel>
            <div style={{ marginTop: '20px' }}>
              {brief.watching_this_week.map((w, i) => (
                <div key={i} style={{ padding: '20px 0', borderBottom: `1px solid ${C.border}` }}>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '20px', fontWeight: 700, color: C.text,
                    marginBottom: '10px', lineHeight: 1.3,
                  }}>
                    <span style={{ color: C.gold, marginRight: '10px' }}>{i + 1}.</span>{w.title}
                  </div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                    color: C.textSoft, lineHeight: 1.7, paddingLeft: '28px',
                  }}>{w.body}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Signature */}
        {brief.signature && (
          <div id="signature" style={{ paddingTop: '52px' }}>
            <SectionLabel>✦ Signature</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '20px' }}>
              {brief.signature.one_number && (
                <div style={{
                  background: C.surface, border: `1px solid ${C.border}`,
                  borderTop: `3px solid ${C.gold}`, padding: '24px',
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '2px', color: C.gold, marginBottom: '14px',
                  }}>ONE NUMBER</div>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '40px', fontWeight: 900, color: C.text,
                    marginBottom: '12px', lineHeight: 1.05,
                  }}>{brief.signature.one_number.value}</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                    color: C.textSoft, lineHeight: 1.65,
                  }}>{brief.signature.one_number.context}</div>
                </div>
              )}
              {brief.signature.one_chart && (
                <div style={{
                  background: C.surface, border: `1px solid ${C.border}`, padding: '24px',
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '2px', color: C.gold, marginBottom: '14px',
                  }}>ONE CHART</div>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '20px', fontWeight: 700, color: C.text,
                    marginBottom: '12px', lineHeight: 1.3,
                  }}>{brief.signature.one_chart.title}</div>
                  {/* Sprint 13.2: actual bars when the writer supplied real
                      numbers from today's stories; description-only otherwise. */}
                  {Array.isArray((brief.signature.one_chart as any).data_points)
                    && (brief.signature.one_chart as any).data_points.length >= 2 && (
                    <div style={{ margin: '6px 0 16px' }}>
                      {(() => {
                        const pts = ((brief.signature.one_chart as any).data_points as { label: string; value: number }[])
                          .filter(p => typeof p?.value === 'number' && isFinite(p.value))
                        const maxV = Math.max(...pts.map(p => Math.abs(p.value)), 1)
                        return pts.map((pt, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                            <div style={{
                              fontFamily: "'DM Mono', monospace", fontSize: '10px',
                              letterSpacing: '1px', color: C.textMute,
                              width: '72px', textAlign: 'right', flexShrink: 0,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>{pt.label}</div>
                            <div style={{ flex: 1, background: C.surface2, borderRadius: '2px', height: '18px', position: 'relative' }}>
                              <div style={{
                                width: `${Math.max(2, Math.round(Math.abs(pt.value) / maxV * 100))}%`,
                                height: '100%', background: C.gold, opacity: 0.85, borderRadius: '2px',
                              }} />
                            </div>
                            <div style={{
                              fontFamily: "'DM Mono', monospace", fontSize: '11px',
                              color: C.text, width: '64px', flexShrink: 0,
                            }}>{pt.value}</div>
                          </div>
                        ))
                      })()}
                    </div>
                  )}
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
                    color: C.textSoft, lineHeight: 1.65, fontStyle: 'italic',
                  }}>{brief.signature.one_chart.description}</div>
                </div>
              )}
              {brief.signature.one_quote && (
                <div style={{
                  background: C.surface2, border: `1px solid ${C.border}`,
                  borderLeft: `3px solid ${C.gold}`, padding: '24px',
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '10px',
                    letterSpacing: '2px', color: C.gold, marginBottom: '14px',
                  }}>ONE QUOTE</div>
                  <div style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: '20px', fontStyle: 'italic',
                    color: C.text, lineHeight: 1.55, marginBottom: '14px',
                  }}>"{brief.signature.one_quote.quote}"</div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: '11px',
                    letterSpacing: '1px', color: C.textMute, marginBottom: '12px',
                  }}>— {brief.signature.one_quote.attribution}</div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                    color: C.textSoft, lineHeight: 1.6,
                  }}>{brief.signature.one_quote.context}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function BriefPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [briefs, setBriefs] = useState<Record<string, BriefContent>>({})
  const [activeEdition, setActiveEdition] = useState<'5min' | '10min' | 'deep'>('10min')
  const [userId, setUserId] = useState<string | null>(null)
  // Sprint 13: Follow a Story state (replaces bookmarks).
  const [storylineByUrl, setStorylineByUrl] = useState<Map<string, { id: string; title: string; confidence: string }>>(new Map())
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set())
  const [busyUrls, setBusyUrls] = useState<Set<string>>(new Set())
  const [savedUrls, setSavedUrls] = useState<Set<string>>(new Set()) // Sprint 14.6
  const [declinedUrls, setDeclinedUrls] = useState<Set<string>>(new Set())
  const [accessToken, setAccessToken] = useState<string>('')
  const [isPersonalised, setIsPersonalised] = useState(false)
  // Sprint 14.2: one desk feature surfaced inside the personalised brief,
  // matched to the reader's interests (read-time, since desks generate after
  // the personalise stage).
  const [deskFeature, setDeskFeature] = useState<{ deskSlug: string; deskName: string; feature: any } | null>(null)
  // Sprint 14.5: which day's brief is being shown (today / yesterday / 2 days
  // ago), driven by the ?date= param the home toggle passes. Defaults to today.
  const [briefDateISO, setBriefDateISO] = useState<string>(istDateISO(0))

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  // Display label for whichever day is being shown, plus its relative tag.
  const briefDateLabel = new Date(`${briefDateISO}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
  const briefDateTag = relativeDateTag(briefDateISO)

  // Optional edition override from URL — used by home flash card buttons:
  // /brief?edition=5min  /brief?edition=10min  /brief?edition=deep
  useEffect(() => {
    if (!router.isReady) return
    const q = router.query.edition
    if (typeof q === 'string' && (q === '5min' || q === '10min' || q === 'deep')) {
      setActiveEdition(q)
    }
  }, [router.isReady, router.query.edition])

  useEffect(() => {
    if (!router.isReady) return
    // Sprint 14.5: resolve which day's brief to load. Only today / yesterday /
    // 2-days-ago are allowed; anything else falls back to today.
    const allowed = [istDateISO(0), istDateISO(1), istDateISO(2)]
    const qDate = typeof router.query.date === 'string' ? router.query.date : ''
    const briefDate = allowed.includes(qDate) ? qDate : istDateISO(0)
    setBriefDateISO(briefDate)
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUserId(user.id)
      // Sprint 14.6: load which stories this user has already saved.
      listSavedUrls(user.id).then((urls) => setSavedUrls(new Set(urls))).catch(() => {})

      const { data: profileData } = await supabase
        .from('profiles').select('*').eq('id', user.id).single()
      setProfile(profileData)
      setIsPersonalised(profileData?.brief_type === 'personalised')

      // Only set from profile if URL didn't already override.
      const urlEdition = typeof router.query.edition === 'string' ? router.query.edition : null
      if (!urlEdition) {
        const raw = profileData?.edition_preference as string
        const norm = normaliseEdition(raw)
        setActiveEdition(norm)
      }

      const loadedBriefs: Record<string, BriefContent> = {}
      const isPers = profileData?.brief_type === 'personalised'

      if (isPers) {
        const { data: personalised } = await supabase
          .from('personalised_briefs')
          .select('edition, content')
          .eq('user_id', user.id)
          .eq('date', briefDate)
          .in('status', ['ready', 'fallback'])
        if (personalised && personalised.length > 0) {
          personalised.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      if (Object.keys(loadedBriefs).length === 0) {
        const { data: standard } = await supabase
          .from('briefs')
          .select('edition, content')
          .eq('date', briefDate)
          .in('status', ['ready', 'fallback'])
        if (standard && standard.length > 0) {
          standard.forEach((row: any) => { loadedBriefs[row.edition] = row.content })
        }
      }

      setBriefs(loadedBriefs)

      // Sprint 14.2: surface one desk feature matching the reader's interests.
      if (isPers && Array.isArray(profileData?.interests) && profileData.interests.length > 0) {
        const INTEREST_TO_DESK: Record<string, string> = {
          'Business & Economy': 'business',
          'Markets & Investing': 'markets',
          'Technology': 'tech', 'Artificial Intelligence': 'tech', 'Science': 'tech',
          'Culture & Arts': 'entertainment', 'Film & OTT': 'entertainment', 'Music': 'entertainment', 'Books & Literature': 'entertainment',
          'Sport': 'sport', 'Cricket': 'sport', 'Football': 'sport', 'Formula 1': 'sport',
          'Indian Politics': 'politics', 'World Affairs': 'politics',
        }
        const wantedSlugs: string[] = []
        for (const i of profileData.interests as string[]) {
          const slug = INTEREST_TO_DESK[i]
          if (slug && !wantedSlugs.includes(slug)) wantedSlugs.push(slug)
        }
        if (wantedSlugs.length > 0) {
          try {
            const [{ data: edRows }, { data: deskRows }] = await Promise.all([
              supabase.from('desk_editions')
                .select('desk_slug, content, status, date')
                .in('desk_slug', wantedSlugs)
                .in('status', ['ready', 'thin'])
                .eq('date', briefDate),
              supabase.from('desks').select('slug, name').in('slug', wantedSlugs),
            ])
            const nameBySlug: Record<string, string> = {}
            for (const d of (deskRows || []) as any[]) nameBySlug[d.slug] = d.name
            // First desk (in the reader's interest order) that has a feature.
            for (const slug of wantedSlugs) {
              const ed = (edRows || []).find((r: any) => r.desk_slug === slug && r.content)
              const feats = ed?.content?.features
              if (Array.isArray(feats) && feats.length > 0) {
                setDeskFeature({ deskSlug: slug, deskName: nameBySlug[slug] || slug, feature: feats[0] })
                break
              }
            }
          } catch { /* non-fatal — card just won't show */ }
        }
      }

      // Sprint 13: storyline mapping (story source_url → storyline) + follows.
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) setAccessToken(session.access_token)

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const [{ data: lineRows }, { data: evRows }, { data: followRows }] = await Promise.all([
        supabase.from('storylines').select('id, title, confidence, status').in('status', ['active', 'dormant']),
        supabase.from('storyline_events').select('storyline_id, source_url').gte('date', sevenDaysAgo),
        supabase.from('storyline_follows').select('storyline_id').eq('user_id', user.id),
      ])
      const lineById = new Map<string, { id: string; title: string; confidence: string }>()
      for (const l of (lineRows || []) as any[]) lineById.set(l.id, { id: l.id, title: l.title, confidence: l.confidence })
      const urlMap = new Map<string, { id: string; title: string; confidence: string }>()
      for (const e of (evRows || []) as any[]) {
        if (e.source_url && lineById.has(e.storyline_id)) urlMap.set(e.source_url, lineById.get(e.storyline_id)!)
      }
      setStorylineByUrl(urlMap)
      setFollowedIds(new Set(((followRows || []) as any[]).map(f => f.storyline_id)))

      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.date])

  // Sprint 13: follow/unfollow. Stories already mapped to a storyline toggle
  // directly via RLS. Unmapped stories ask /api/storylines to qualify +
  // create + follow (one-time), then fire-and-forget the historical backfill
  // — the page never blocks on it (async story-so-far by design).
  const toggleFollow = async (story: any) => {
    if (!userId) {
      alert('Your session was not found — please log in again.')
      return
    }
    const url = story?.source_url || ''
    const line = url ? storylineByUrl.get(url) : undefined

    if (line) {
      const isFollowing = followedIds.has(line.id)
      setFollowedIds(prev => {
        const next = new Set(prev)
        if (isFollowing) next.delete(line.id); else next.add(line.id)
        return next
      })
      if (isFollowing) {
        const { error } = await supabase
          .from('storyline_follows').delete()
          .eq('user_id', userId).eq('storyline_id', line.id)
        if (error) {
          setFollowedIds(prev => new Set(prev).add(line.id))
          alert('Could not unfollow: ' + error.message)
        }
      } else {
        const { error } = await supabase
          .from('storyline_follows')
          .insert({ user_id: userId, storyline_id: line.id })
        if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
          setFollowedIds(prev => { const next = new Set(prev); next.delete(line.id); return next })
          alert('Could not follow: ' + error.message)
        }
      }
      return
    }

    // No storyline for this story yet — qualify + create via the API.
    if (!url || busyUrls.has(url)) return
    setBusyUrls(prev => new Set(prev).add(url))
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      const resp = await fetch('/api/storylines', {
        method: 'POST', headers,
        body: JSON.stringify({
          action: 'create-and-follow',
          story: {
            headline: story?.headline || '',
            summary: story?.facts || story?.what_happened || story?.body || '',
            source: story?.source || '',
            source_url: url,
          },
        }),
      })
      const data = await resp.json()
      if (data?.ok && data?.qualified && data?.storyline?.id) {
        const newLine = { id: data.storyline.id, title: data.storyline.title, confidence: data.storyline.confidence || 'normal' }
        setStorylineByUrl(prev => { const next = new Map(prev); next.set(url, newLine); return next })
        setFollowedIds(prev => new Set(prev).add(newLine.id))
        // Fire-and-forget "how we got here" backfill; the morning pipeline
        // self-heals any storyline left without a story_so_far.
        void fetch('/api/storylines', {
          method: 'POST', headers,
          body: JSON.stringify({ action: 'backfill', storylineId: newLine.id }),
        }).catch(() => {})
      } else if (data?.ok && data?.qualified === false) {
        setDeclinedUrls(prev => new Set(prev).add(url))
        setTimeout(() => {
          setDeclinedUrls(prev => { const next = new Set(prev); next.delete(url); return next })
        }, 4000)
      } else {
        alert('Could not follow this story: ' + (data?.error || 'unknown error'))
      }
    } catch (e: any) {
      alert('Could not follow this story: ' + (e?.message || e))
    } finally {
      setBusyUrls(prev => { const next = new Set(prev); next.delete(url); return next })
    }
  }

  const followApi: FollowApi = {
    stateFor: (story: any) => {
      const url = story?.source_url || ''
      if (url && busyUrls.has(url)) return 'busy'
      if (url && declinedUrls.has(url)) return 'declined'
      const line = url ? storylineByUrl.get(url) : undefined
      if (line && followedIds.has(line.id)) return 'following'
      if (line) return 'none'
      // Unmapped story: the pipeline's qualifying test didn't make it part of
      // any storyline today — hide the pill (Sprint 13.2 decision).
      return SHOW_FOLLOW_ON_UNMAPPED ? 'none' : 'hidden'
    },
    nudgeFor: (story: any) => {
      const url = story?.source_url || ''
      const line = url ? storylineByUrl.get(url) : undefined
      return !!line && line.confidence === 'high' && !followedIds.has(line.id)
    },
    toggle: toggleFollow,
  }

  // Sprint 14.6: optimistic save/unsave with revert on failure.
  const toggleSave = async (story: any) => {
    const url = story?.source_url || ''
    if (!url || !userId) return
    const wasSaved = savedUrls.has(url)
    setSavedUrls((prev) => { const n = new Set(prev); if (wasSaved) n.delete(url); else n.add(url); return n })
    const res = wasSaved
      ? await unsaveStory(userId, url)
      : await saveStory(userId, { source_url: url, headline: story.headline, source: story.source })
    if (res.error) {
      setSavedUrls((prev) => { const n = new Set(prev); if (wasSaved) n.add(url); else n.delete(url); return n })
      console.warn('[saved] toggle failed:', res.error)
    }
  }
  const saveApi: SaveApi = {
    isSaved: (s: any) => !!s?.source_url && savedUrls.has(s.source_url),
    toggle: toggleSave,
  }

  const activeBrief = briefs[activeEdition]
  const hasBriefs = Object.keys(briefs).length > 0

  return (
    <SavedContext.Provider value={saveApi}>
    <div style={{ minHeight: '100vh', background: C.bg }}>
      {/* Header */}
      <div style={{
        background: C.bg, borderBottom: `2px solid ${C.gold}`,
        padding: '22px 20px 16px', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '14px' }}>
          <Link href="/home" style={{
            color: C.textMute, textDecoration: 'none', fontSize: '22px',
            marginRight: '18px', minHeight: '44px',
            display: 'flex', alignItems: 'center',
          }}>←</Link>
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '30px', fontWeight: 900, color: C.text, lineHeight: 1,
            }}>Morning</div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontSize: '30px', fontWeight: 900, color: C.gold, lineHeight: 1,
            }}>Brief</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            {briefDateTag && (
              <div style={{
                fontFamily: "'DM Mono', monospace", fontSize: '10px',
                letterSpacing: '1.5px', color: C.gold, lineHeight: 1.7,
              }}>{briefDateTag}</div>
            )}
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.textMute, lineHeight: 1.7,
            }}>{(briefDateTag ? briefDateLabel : today).toUpperCase()}</div>
            <div style={{
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: C.gold,
            }}>{editionDisplay(activeEdition).toUpperCase()}</div>
          </div>
        </div>

        {hasBriefs && (
          <div style={{ display: 'flex', marginTop: '4px' }}>
            {(['5min', '10min', 'deep'] as const).map(ed =>
              briefs[ed] ? (
                <EditionTab key={ed}
                  label={editionDisplay(ed)}
                  active={activeEdition === ed}
                  onClick={() => setActiveEdition(ed)} />
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
          <>
            {isPersonalised && deskFeature && (
              <DeskFeatureCard
                deskSlug={deskFeature.deskSlug}
                deskName={deskFeature.deskName}
                feature={deskFeature.feature}
              />
            )}
            {activeEdition === '5min' ? (
              <QuickRenderer
                brief={activeBrief}
                follow={followApi}
              />
            ) : activeEdition === '10min' ? (
              <DailyRenderer
                brief={activeBrief}
                follow={followApi}
                isPersonalised={isPersonalised}
              />
            ) : (
              <EditorialRenderer
                brief={activeBrief}
                isPersonalised={isPersonalised}
              />
            )}
          </>
        ) : (
          <NoBrief profile={profile} />
        )}
      </div>

      {/* Bottom nav */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: C.surface, borderTop: `1px solid ${C.border}`,
        display: 'flex', height: '64px',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {[
          { href: '/home',      label: 'Brief',   icon: '◆', active: true },
          { href: '/followed',  label: 'Stories', icon: '◉', active: false },
          { href: '/desks',     label: 'Desks',   icon: '▦', active: false },
          { href: '/profile',   label: 'Profile', icon: '◑', active: false },
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
    </SavedContext.Provider>
  )
}
