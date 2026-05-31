import Link from 'next/link'

const C = {
  bg: '#0E0E0E',
  surface: '#161616',
  border: '#262626',
  gold: '#C8A45A',
  text: '#F5F1EA',
  textSoft: '#CFC6B8',
  textMute: '#8E867B',
}

export default function Habits() {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: '80px' }}>

      {/* Header */}
      <div style={{
        background: C.bg,
        borderBottom: `2px solid ${C.gold}`,
        padding: '0 20px', display: 'flex', alignItems: 'center',
        gap: '18px', height: '56px',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <Link href="/home" style={{
          color: C.textMute, textDecoration: 'none', fontSize: '22px',
          minHeight: '44px', display: 'flex', alignItems: 'center',
        }}>←</Link>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '11px',
          letterSpacing: '2.5px', color: C.gold,
        }}>HABIT TRACKER</div>
      </div>

      <div style={{ padding: '64px 24px', textAlign: 'center', maxWidth: '420px', margin: '0 auto' }}>
        <div style={{ fontSize: '40px', marginBottom: '20px', color: C.gold }}>◎</div>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '26px', fontStyle: 'italic',
          color: C.text, marginBottom: '14px', lineHeight: 1.3,
        }}>
          Habit Tracker
        </div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: '16px',
          color: C.textSoft, lineHeight: 1.7,
        }}>
          30-day plans, daily micro-habits, streaks and group goals. Coming in the next build.
        </div>
      </div>

      {/* Bottom nav — 3-item (synced with rest of app) */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: C.surface, borderTop: `1px solid ${C.border}`,
        display: 'flex', height: '64px',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {[
          { href: '/home',      label: 'Brief',   icon: '◆', active: false },
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
              fontFamily: "'DM Mono', monospace", fontSize: '10px',
              letterSpacing: '1.5px', color: active ? C.gold : C.textMute,
            }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
