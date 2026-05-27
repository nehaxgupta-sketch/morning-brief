import { useEffect } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function Landing() {
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) router.push('/home')
    })
  }, [])

  return (
    <div style={{
      minHeight: '100vh',
      background: '#1A1A1A',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Background texture */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 24px, rgba(200,164,90,0.03) 24px, rgba(200,164,90,0.03) 25px)`,
        pointerEvents: 'none'
      }} />

      {/* Gold top rule */}
      <div style={{ height: '3px', background: 'linear-gradient(90deg, transparent, #C8A45A, transparent)' }} />

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        gap: '0'
      }}>

        {/* Edition label */}
        <div className="animate-fade-up stagger-1" style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '9px',
          letterSpacing: '4px',
          color: '#C8A45A',
          textTransform: 'uppercase',
          marginBottom: '16px'
        }}>
          Est. 2026 · Bengaluru
        </div>

        {/* Masthead */}
        <h1 className="animate-fade-up stagger-2" style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(42px, 12vw, 72px)',
          fontWeight: '900',
          color: '#F5F1EA',
          lineHeight: '0.95',
          letterSpacing: '-1px',
          textAlign: 'center',
          marginBottom: '8px'
        }}>
          Morning
        </h1>
        <h1 className="animate-fade-up stagger-2" style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(42px, 12vw, 72px)',
          fontWeight: '900',
          fontStyle: 'italic',
          color: '#C8A45A',
          lineHeight: '0.95',
          letterSpacing: '-1px',
          textAlign: 'center',
          marginBottom: '32px'
        }}>
          Brief
        </h1>

        {/* Gold rule */}
        <div className="animate-fade-up stagger-3" style={{
          width: '48px',
          height: '1px',
          background: '#C8A45A',
          marginBottom: '24px',
          opacity: 0.6
        }} />

        {/* Tagline */}
        <p className="animate-fade-up stagger-3" style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '16px',
          fontStyle: 'italic',
          color: '#888',
          textAlign: 'center',
          lineHeight: '1.6',
          maxWidth: '280px',
          marginBottom: '48px'
        }}>
          Your world, curated for who you are.
          Ready at 7 AM, every morning.
        </p>

        {/* CTA Buttons */}
        <div className="animate-fade-up stagger-4" style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '100%',
          maxWidth: '320px'
        }}>
          <Link href="/signup" style={{
            display: 'block',
            width: '100%',
            padding: '16px 24px',
            background: '#C8A45A',
            color: '#1A1A1A',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            fontWeight: '600',
            letterSpacing: '1px',
            textTransform: 'uppercase',
            textAlign: 'center',
            textDecoration: 'none',
            border: 'none',
            cursor: 'pointer',
            minHeight: '52px'
          }}>
            Start Reading Free
          </Link>

          <Link href="/login" style={{
            display: 'block',
            width: '100%',
            padding: '16px 24px',
            background: 'transparent',
            color: '#F5F1EA',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            fontWeight: '400',
            letterSpacing: '0.5px',
            textAlign: 'center',
            textDecoration: 'none',
            border: '1px solid rgba(245,241,234,0.2)',
            cursor: 'pointer',
            minHeight: '52px'
          }}>
            I already have an account
          </Link>
        </div>

        {/* Feature pills */}
        <div className="animate-fade-up stagger-5" style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          justifyContent: 'center',
          marginTop: '48px',
          maxWidth: '320px'
        }}>
          {['World · India · Bengaluru', '3 reading depths', 'Personalised to you', 'Daily habit tracker'].map(f => (
            <span key={f} style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '1px',
              color: '#555',
              border: '1px solid #333',
              padding: '4px 10px',
              borderRadius: '2px'
            }}>{f}</span>
          ))}
        </div>
      </div>

      {/* Bottom rule */}
      <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(200,164,90,0.3), transparent)' }} />
      <div style={{
        padding: '12px',
        textAlign: 'center',
        fontFamily: "'DM Mono', monospace",
        fontSize: '9px',
        color: '#333',
        letterSpacing: '1px'
      }}>
        BENGALURU · DELHI · INDIA · WORLD
      </div>
    </div>
  )
}
