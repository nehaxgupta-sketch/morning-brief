import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

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
  err: '#E76161',
}

type Bookmark = {
  id: string
  brief_date: string
  edition: string
  section: string
  headline: string
  body: string
  source: string | null
  source_url: string | null
  created_at: string
}

const sectionEmoji: Record<string, string> = {
  world: '🌍',
  india: '🇮🇳',
  major_events: '🔥',
  your_city: '📍',
  bengaluru: '🏙️',
  delhi: '🏛️',
  business: '💼',
  markets: '📈',
  technology: '💻',
  climate_health: '🌱',
  sport: '🏏',
  culture: '🎭',
}

const sectionLabel: Record<string, string> = {
  climate_health: 'climate',
  technology: 'tech',
  major_events: 'major events',
  your_city: 'your city',
}

const editionLabel: Record<string, string> = {
  '5min': '5-MIN',
  '10min': '10-MIN',
  'deep': 'DEEP',
}

export default function BookmarksPage() {
  const router = useRouter()
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    checkAuthAndLoad()
  }, [])

  async function checkAuthAndLoad() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      window.location.href = '/login'
      return
    }
    loadBookmarks(session.user.id)
  }

  async function loadBookmarks(userId: string) {
    setLoading(true)
    const { data, error } = await supabase
      .from('bookmarks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (!error && data) setBookmarks(data)
    setLoading(false)
  }

  async function removeBookmark(id: string) {
    setRemoving(id)
    await supabase.from('bookmarks').delete().eq('id', id)
    setBookmarks(prev => prev.filter(b => b.id !== id))
    setRemoving(null)
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    })
  }

  const grouped = bookmarks.reduce<Record<string, Bookmark[]>>((acc, b) => {
    const key = b.brief_date
    if (!acc[key]) acc[key] = []
    acc[key].push(b)
    return acc
  }, {})

  return (
    <>
      <Head>
        <title>Saved — Morning Brief</title>
      </Head>

      <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: '88px' }}>

        {/* Header */}
        <div style={{
          padding: '52px 24px 28px',
          borderBottom: `2px solid ${C.gold}`,
          background: C.bg,
        }}>
          <p style={{
            fontFamily: "'DM Mono', monospace", fontSize: '11px',
            color: C.gold, letterSpacing: '2.5px',
            textTransform: 'uppercase', margin: '0 0 10px',
          }}>
            Your collection
          </p>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif", fontSize: '36px',
            fontWeight: 900, color: C.text, margin: 0, lineHeight: 1.15,
          }}>
            Saved Stories
          </h1>
          {!loading && bookmarks.length > 0 && (
            <p style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: '15px',
              color: C.textSoft, marginTop: '12px', marginBottom: 0,
            }}>
              {bookmarks.length} {bookmarks.length === 1 ? 'story' : 'stories'} saved
            </p>
          )}
        </div>

        {/* Content */}
        <div style={{ padding: '28px 20px 0', maxWidth: '480px', margin: '0 auto' }}>

          {loading && (
            <div style={{ textAlign: 'center', paddingTop: '80px' }}>
              <div style={{
                width: '32px', height: '32px',
                border: `2px solid ${C.border}`,
                borderTopColor: C.gold, borderRadius: '50%',
                animation: 'spin 0.8s linear infinite', margin: '0 auto',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {!loading && bookmarks.length === 0 && (
            <div style={{ textAlign: 'center', paddingTop: '80px' }}>
              <div style={{ fontSize: '54px', marginBottom: '20px', color: C.gold }}>☆</div>
              <p style={{
                fontFamily: "'Playfair Display', Georgia, serif", fontSize: '22px',
                color: C.text, marginBottom: '12px', lineHeight: 1.3,
              }}>
                Nothing saved yet
              </p>
              <p style={{
                fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                color: C.textSoft, marginBottom: '36px', lineHeight: 1.6,
              }}>
                Tap the ☆ on any story while reading your brief.
              </p>
              <Link
                href="/brief"
                style={{
                  background: C.gold, color: '#0E0E0E', border: 'none',
                  borderRadius: '2px', padding: '16px 32px',
                  fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
                  fontWeight: 700, letterSpacing: '1.5px',
                  textTransform: 'uppercase', textDecoration: 'none',
                  display: 'inline-block', minHeight: '52px',
                }}
              >
                Read Today's Brief
              </Link>
            </div>
          )}

          {!loading && Object.entries(grouped).map(([date, items]) => (
            <div key={date} style={{ marginBottom: '44px' }}>
              {/* Date group header */}
              <p style={{
                fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: C.gold, letterSpacing: '2.5px',
                textTransform: 'uppercase',
                marginBottom: '20px', marginTop: 0,
              }}>
                {formatDate(date)}
              </p>

              {items.map(bookmark => (
                <div
                  key={bookmark.id}
                  style={{
                    background: C.surface,
                    borderRadius: '0px',
                    padding: '22px',
                    marginBottom: '14px',
                    border: `1px solid ${C.border}`,
                    position: 'relative',
                  }}
                >
                  {/* Section pill */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
                    <span style={{ fontSize: '15px' }}>
                      {sectionEmoji[bookmark.section] || '📰'}
                    </span>
                    <span style={{
                      fontFamily: "'DM Mono', monospace", fontSize: '10px',
                      color: C.textMute, textTransform: 'uppercase', letterSpacing: '1.5px',
                    }}>
                      {(sectionLabel[bookmark.section] || bookmark.section)} · {editionLabel[bookmark.edition] || bookmark.edition.toUpperCase()}
                    </span>
                  </div>

                  {/* Headline */}
                  <p style={{
                    fontFamily: "'Playfair Display', Georgia, serif", fontSize: '20px',
                    fontWeight: 700, color: C.text, margin: '0 0 12px',
                    lineHeight: 1.35,
                  }}>
                    {bookmark.headline}
                  </p>

                  {/* Body */}
                  <p style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
                    color: C.textSoft, lineHeight: 1.7, margin: '0 0 16px',
                  }}>
                    {bookmark.body}
                  </p>

                  {/* Footer row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px' }}>
                    {bookmark.source && (
                      bookmark.source_url ? (
                        <a
                          href={bookmark.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontFamily: "'DM Mono', monospace", fontSize: '11px',
                            color: C.textMute, textDecoration: 'none',
                            letterSpacing: '1px',
                          }}
                        >
                          via {bookmark.source} ↗
                        </a>
                      ) : (
                        <span style={{
                          fontFamily: "'DM Mono', monospace", fontSize: '11px',
                          color: C.textDim, letterSpacing: '1px',
                        }}>
                          via {bookmark.source}
                        </span>
                      )
                    )}
                    <button
                      onClick={() => removeBookmark(bookmark.id)}
                      disabled={removing === bookmark.id}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
                        color: removing === bookmark.id ? C.textDim : C.err,
                        padding: '6px 0', marginLeft: 'auto', minHeight: '44px',
                      }}
                    >
                      {removing === bookmark.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Bottom nav */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: C.surface, borderTop: `1px solid ${C.border}`,
          display: 'flex', height: '64px',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}>
          {[
            { href: '/home',      label: 'Brief',   icon: '◆', active: false },
            { href: '/bookmarks', label: 'Saved',   icon: '★', active: true },
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
    </>
  )
}
