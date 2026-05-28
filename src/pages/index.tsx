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
      minHeight: '100vh', background: '#1A1A1A',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 24px, rgba(200,164,90,0.03) 24px, rgba(200,164,90,0.03) 25px)`,
        pointerEvents: 'none'
      }} />
      <div style={{ height: '3px', background: 'linear-gradient(90deg, transparent, #C8A45A, transparent)' }} />
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '40px 24px'
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '9px',
          letterSpacing: '4px', color: '#C8A45A',
          textTransform: 'uppercase', marginBottom: '16px',
          animation: 'fadeUp 0.5s ease forwards'
        }}>Est. 2026 · Bengaluru</div>

        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(56px, 15vw, 88px)', fontWeight: '900',
          color: '#F5F1EA', lineHeight: '0.95', letterSpacing: '-1px',
          textAlign: 'center', marginBottom: '4px',
          animation: 'fadeUp 0.5s 0.1s ease forwards', opacity: 0
        }}>Morning</h1>
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(56px, 15vw, 88px)', fontWeight: '900',
          color: '#C8A45A',
          lineHeight: '0.95', letterSpacing: '-1px',
          textAlign: 'center', marginBottom: '32px',
          animation: 'fadeUp 0.5s 0.15s ease forwards', opacity: 0
        }}>Brief</h1>

        <div style={{
          width: '48px', height: '1px', background: '#C8A45A',
          marginBottom: '24px', opacity: 0.6,
          animation: 'fadeUp 0.5s 0.2s ease forwards'
        }} />

        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '16px', color: '#B0A898',
          textAlign: 'center', lineHeight: '1.6',
          maxWidth: '280px', marginBottom: '48px',
          animation: 'fadeUp 0.5s 0.25s ease forwards', opacity: 0
        }}>Your world, curated for who you are. Ready at 7 AM, every morning.</p>

        <div style={{
          display: 'flex', flexDirection: 'column', gap: '12px',
          width: '100%', maxWidth: '320px',
          animation: 'fadeUp 0.5s 0.3s ease forwards', opacity: 0
        }}>
          <Link href="/signup" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '100%', padding: '16px 24px',
            background: '#C8A45A', color: '#1A1A1A',
            fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
            fontWeight: '600', letterSpacing: '1px',
            textTransform: 'uppercase', textAlign: 'center',
            textDecoration: 'none', minHeight: '52px'
          }}>Create Your Account</Link>

          <Link href="/login" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '100%', padding: '16px 24px',
            background: 'transparent', color: '#F5F1EA',
            fontFamily: "'DM Sans', sans-serif", fontSize: '14px',
            fontWeight: '400', textAlign: 'center',
            textDecoration: 'none',
            border: '1px solid rgba(245,241,234,0.15)',
            minHeight: '52px'
          }}>I already have an account</Link>
        </div>

        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '8px',
          justifyContent: 'center', marginTop: '48px', maxWidth: '320px',
          animation: 'fadeUp 0.5s 0.4s ease forwards', opacity: 0
        }}>
          {['World · India · Your City', '3 reading depths', 'Personalised for you', 'Your tone, your lens'].map(f => (
            <span key={f} style={{
              fontFamily: "'DM Mono', monospace", fontSize: '9px',
              letterSpacing: '1px', color: '#999',
              border: '1px solid #444', padding: '4px 10px', borderRadius: '2px'
            }}>{f}</span>
          ))}
        </div>
      </div>
      <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(200,164,90,0.3), transparent)' }} />
      <div style={{
        padding: '12px', textAlign: 'center',
        fontFamily: "'DM Mono', monospace", fontSize: '9px',
        color: '#2A2A2A', letterSpacing: '1px'
      }}>YOUR CITIES · INDIA · WORLD</div>
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
