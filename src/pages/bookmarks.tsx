import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { supabase } from '@/lib/supabase'

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

  // Group bookmarks by date
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

      <div style={{ background: '#1A1A1A', minHeight: '100vh', paddingBottom: '80px' }}>

        {/* Header */}
        <div style={{
          padding: '48px 24px 24px',
          borderBottom: '1px solid #2A2A2A',
        }}>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px', color: '#888', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '8px' }}>
            Your collection
          </p>
          <h1 style={{ fontFamily: 'Playfair Display, serif', fontSize: '32px', fontWeight: 900, color: '#F5F1EA', margin: 0 }}>
            Saved Stories
          </h1>
          {!loading && bookmarks.length > 0 && (
            <p style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '14px', color: '#888', marginTop: '8px' }}>
              {bookmarks.length} {bookmarks.length === 1 ? 'story' : 'stories'} saved
            </p>
          )}
        </div>

        {/* Content */}
        <div style={{ padding: '24px 24px 0' }}>

          {loading && (
            <div style={{ textAlign: 'center', paddingTop: '80px' }}>
              <div style={{
                width: '32px', height: '32px', border: '2px solid #333',
                borderTopColor: '#C8A45A', borderRadius: '50%',
                animation: 'spin 0.8s linear infinite', margin: '0 auto',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {!loading && bookmarks.length === 0 && (
            <div style={{ textAlign: 'center', paddingTop: '80px' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px', color: '#C8A45A' }}>☆</div>
              <p style={{ fontFamily: 'Playfair Display, serif', fontSize: '20px', color: '#F5F1EA', marginBottom: '8px' }}>
                Nothing saved yet
              </p>
              <p style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '15px', color: '#888', marginBottom: '32px' }}>
                Tap the ☆ on any story while reading your brief.
              </p>
              <button
                onClick={() => window.location.href = '/brief'}
                style={{
                  background: '#C8A45A', color: '#1A1A1A', border: 'none',
                  borderRadius: '12px', padding: '14px 28px',
                  fontFamily: 'DM Sans, sans-serif', fontSize: '15px', fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Read Today's Brief
              </button>
            </div>
          )}

          {!loading && Object.entries(grouped).map(([date, items]) => (
            <div key={date} style={{ marginBottom: '40px' }}>
              {/* Date group header */}
              <p style={{
                fontFamily: 'DM Mono, monospace', fontSize: '11px', color: '#C8A45A',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                marginBottom: '16px', marginTop: '0',
              }}>
                {formatDate(date)}
              </p>

              {items.map(bookmark => (
                <div
                  key={bookmark.id}
                  style={{
                    background: '#242424',
                    borderRadius: '16px',
                    padding: '20px',
                    marginBottom: '12px',
                    border: '1px solid #2E2E2E',
                    position: 'relative',
                  }}
                >
                  {/* Section pill */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '14px' }}>
                      {sectionEmoji[bookmark.section] || '📰'}
                    </span>
                    <span style={{
                      fontFamily: 'DM Mono, monospace', fontSize: '10px',
                      color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em',
                    }}>
                      {(sectionLabel[bookmark.section] || bookmark.section)} · {bookmark.edition}
                    </span>
                  </div>

                  {/* Headline */}
                  <p style={{
                    fontFamily: 'Playfair Display, serif', fontSize: '18px',
                    fontWeight: 700, color: '#F5F1EA', margin: '0 0 10px',
                    lineHeight: 1.35,
                  }}>
                    {bookmark.headline}
                  </p>

                  {/* Body */}
                  <p style={{
                    fontFamily: 'DM Sans, sans-serif', fontSize: '15px',
                    color: '#C0B9AF', lineHeight: 1.6, margin: '0 0 12px',
                  }}>
                    {bookmark.body}
                  </p>

                  {/* Footer row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    {bookmark.source && (
                      bookmark.source_url ? (
                        <a
                          href={bookmark.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontFamily: 'DM Mono, monospace', fontSize: '11px',
                            color: '#888', textDecoration: 'none',
                          }}
                        >
                          {bookmark.source} ↗
                        </a>
                      ) : (
                        <span style={{
                          fontFamily: 'DM Mono, monospace', fontSize: '11px', color: '#666',
                        }}>
                          {bookmark.source}
                        </span>
                      )
                    )}
                    <button
                      onClick={() => removeBookmark(bookmark.id)}
                      disabled={removing === bookmark.id}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontFamily: 'DM Sans, sans-serif', fontSize: '13px',
                        color: removing === bookmark.id ? '#555' : '#E05C5C',
                        padding: '4px 0', marginLeft: 'auto',
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
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: '#1A1A1A', borderTop: '1px solid #2A2A2A',
          display: 'flex', justifyContent: 'space-around', padding: '12px 0 20px',
          zIndex: 100,
        }}>
          {[
            { label: 'Brief', icon: '📰', href: '/brief' },
            { label: 'Saved', icon: '★', href: '/bookmarks' },
            { label: 'Profile', icon: '👤', href: '/profile' },
          ].map(item => {
            const active = item.href === '/bookmarks'
            return (
              <button
                key={item.href}
                onClick={() => window.location.href = item.href}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                  padding: '0 24px',
                }}
              >
                <span style={{ fontSize: '20px' }}>{item.icon}</span>
                <span style={{
                  fontFamily: 'DM Mono, monospace', fontSize: '10px',
                  color: active ? '#C8A45A' : '#888',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  {item.label}
                </span>
              </button>
            )
          })}
        </nav>
      </div>
    </>
  )
}
