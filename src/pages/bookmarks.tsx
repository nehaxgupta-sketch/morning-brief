import Link from 'next/link'

export default function Bookmarks() {
  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>
      <div style={{
        background: '#1A1A1A', borderBottom: '2px solid #C8A45A',
        padding: '0 20px', display: 'flex', alignItems: 'center',
        gap: '16px', height: '52px'
      }}>
        <Link href="/home" style={{ color: '#888', textDecoration: 'none', fontSize: '18px', minHeight: '44px', display: 'flex', alignItems: 'center' }}>←</Link>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '2px', color: '#888' }}>SAVED STORIES</div>
      </div>

      <div style={{ padding: '48px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '16px' }}>◈</div>
        <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: '22px', fontStyle: 'italic', color: '#1A1A1A', marginBottom: '8px' }}>
          Saved Stories
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: '#888', lineHeight: '1.6', maxWidth: '260px', margin: '0 auto' }}>
          Bookmark stories and follow them as they develop. News memory coming in the next build.
        </div>
      </div>

      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: '#1A1A1A', borderTop: '1px solid #2A2A2A',
        display: 'flex', height: '60px'
      }}>
        {[
          { href: '/home', label: 'Brief', icon: '◆', active: false },
          { href: '/habits', label: 'Habits', icon: '◎', active: false },
          { href: '/bookmarks', label: 'Saved', icon: '◈', active: true },
          { href: '/profile', label: 'Profile', icon: '◑', active: false },
        ].map(({ href, label, icon, active }) => (
          <Link key={href} href={href} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '2px', textDecoration: 'none', minHeight: '60px'
          }}>
            <span style={{ fontSize: '16px', color: active ? '#C8A45A' : '#444' }}>{icon}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '8px', letterSpacing: '1px', color: active ? '#C8A45A' : '#444' }}>{label.toUpperCase()}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
