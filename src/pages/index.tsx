// src/pages/index.tsx
import { useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Design tokens (kept inline so each file is self-contained) ─────────────
const C = {
  bg: '#0E0E0E',
  surface: '#161616',
  border: '#262626',
  gold: '#C8A45A',
  text: '#F5F1EA',
  textSoft: '#CFC6B8',
  textMute: '#8E867B',
}

export default function Landing() {
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) window.location.href = '/home'
    })
  }, [])

  return (
    <div style={{
      minHeight: '100vh',
      background: C.bg,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle horizontal-line texture */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 28px, rgba(200,164,90,0.025) 28px, rgba(200,164,90,0.025) 29px)',
        pointerEvents: 'none',
      }} />

      {/* Top hairline accent */}
      <div style={{ height: '3px', background: `linear-gradient(90deg, transparent, ${C.gold}, transparent)` }} />

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        position: 'relative',
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '11px',
          letterSpacing: '4px',
          color: C.gold,
          textTransform: 'uppercase',
          marginBottom: '20px',
          animation: 'fadeUp 0.5s ease forwards',
        }}>
          Est. 2026 · Bengaluru
        </div>

        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(60px, 16vw, 92px)',
          fontWeight: 900,
          color: C.text,
          lineHeight: '0.95',
          letterSpacing: '-1.5px',
          textAlign: 'center',
          marginBottom: '0',
          animation: 'fadeUp 0.5s 0.1s ease forwards',
          opacity: 0,
        }}>Morning</h1>

        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 'clamp(60px, 16vw, 92px)',
          fontWeight: 900,
          color: C.gold,
          lineHeight: '0.95',
          letterSpacing: '-1.5px',
          textAlign: 'center',
          marginBottom: '36px',
          animation: 'fadeUp 0.5s 0.15s ease forwards',
          opacity: 0,
        }}>Brief</h1>

        <div style={{
          width: '52px',
          height: '1px',
          background: C.gold,
          marginBottom: '28px',
          opacity: 0.6,
          animation: 'fadeUp 0.5s 0.2s ease forwards',
        }} />

        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '17px',
          color: C.textSoft,
          textAlign: 'center',
          lineHeight: '1.65',
          maxWidth: '320px',
          marginBottom: '52px',
          animation: 'fadeUp 0.5s 0.25s ease forwards',
          opacity: 0,
        }}>
          Your world, curated for who you are. Ready at 7 AM, every morning.
        </p>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '100%',
          maxWidth: '340px',
          animation: 'fadeUp 0.5s 0.3s ease forwards',
          opacity: 0,
        }}>
          <Link href="/signup" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            padding: '17px 24px',
            background: C.gold,
            color: '#1A1A1A',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            fontWeight: 700,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            textDecoration: 'none',
            minHeight: '54px',
            borderRadius: '3px',
          }}>
            Create Your Account
          </Link>
          <Link href="/login" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            padding: '17px 24px',
            background: 'transparent',
            color: C.text,
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            fontWeight: 500,
            textDecoration: 'none',
            border: `1px solid ${C.border}`,
            minHeight: '54px',
            borderRadius: '3px',
          }}>
            I already have an account
          </Link>
        </div>

        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          justifyContent: 'center',
          marginTop: '52px',
          maxWidth: '340px',
          animation: 'fadeUp 0.5s 0.4s ease forwards',
          opacity: 0,
        }}>
          {['World · India · Your City', '3 reading depths', 'Personalised for you', 'Your tone, your lens'].map(f => (
            <span key={f} style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '1.5px',
              color: C.textMute,
              border: `1px solid ${C.border}`,
              padding: '5px 11px',
              borderRadius: '3px',
            }}>{f}</span>
          ))}
        </div>
      </div>

      <div style={{
        height: '1px',
        background: `linear-gradient(90deg, transparent, rgba(200,164,90,0.3), transparent)`,
      }} />

      <div style={{
        padding: '14px',
        textAlign: 'center',
        fontFamily: "'DM Mono', monospace",
        fontSize: '10px',
        color: '#2F2A24',
        letterSpacing: '2px',
      }}>
        YOUR CITIES · INDIA · WORLD
      </div>

      <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  )
}
