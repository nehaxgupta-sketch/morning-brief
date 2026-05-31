// src/pages/forgot-password.tsx
import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

const C = {
  bg: '#0E0E0E',
  surface: '#1C1C1C',
  border: '#262626',
  gold: '#C8A45A',
  text: '#F5F1EA',
  textSoft: '#CFC6B8',
  textMute: '#8E867B',
  err: '#E76161',
}

type Stage = 'form' | 'sent'

function Wordmark() {
  return (
    <div style={{ textAlign: 'center', marginBottom: '32px' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: 'clamp(40px, 11vw, 56px)',
        fontWeight: 900,
        color: C.text,
        letterSpacing: '-1px',
        lineHeight: '1',
        marginBottom: '2px',
      }}>Morning</div>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: 'clamp(40px, 11vw, 56px)',
        fontWeight: 900,
        color: C.gold,
        letterSpacing: '-1px',
        lineHeight: '1',
      }}>Brief</div>
    </div>
  )
}

export default function ForgotPassword() {
  const [stage, setStage] = useState<Stage>('form')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleReset = async () => {
    if (!email.trim()) { setError('Please enter your email'); return }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) { setError(error.message); setLoading(false); return }
    setStage('sent')
    setLoading(false)
  }

  if (stage === 'sent') {
    return (
      <div style={{
        minHeight: '100vh',
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '52px', marginBottom: '24px' }}>✉️</div>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px',
          letterSpacing: '3px',
          color: C.gold,
          marginBottom: '14px',
        }}>CHECK YOUR EMAIL</div>
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '28px',
          fontWeight: 700,
          color: C.text,
          marginBottom: '20px',
        }}>Reset link sent</h1>
        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          color: C.textSoft,
          lineHeight: '1.7',
          maxWidth: '320px',
          marginBottom: '32px',
        }}>
          We've sent a password reset link to<br />
          <span style={{ color: C.gold }}>{email}</span><br /><br />
          Click the link in that email to set a new password.
        </p>
        <Link href="/login" style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '11px',
          letterSpacing: '1.5px',
          color: C.gold,
          textDecoration: 'underline',
        }}>BACK TO SIGN IN</Link>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: C.bg,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>
        <Wordmark />
        <h1 style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '18px',
          fontWeight: 400,
          color: C.textSoft,
          textAlign: 'center',
          marginBottom: '10px',
        }}>Reset your password</h1>
        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px',
          color: C.textMute,
          textAlign: 'center',
          lineHeight: '1.55',
          marginBottom: '32px',
        }}>Enter your email and we'll send you a reset link.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label style={{
              display: 'block',
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '2px',
              color: C.textMute,
              marginBottom: '8px',
              textTransform: 'uppercase',
            }}>Email address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="priya@email.com"
              onKeyDown={e => e.key === 'Enter' && handleReset()}
              style={{
                width: '100%',
                padding: '15px 16px',
                background: C.surface,
                border: `1px solid ${email ? C.gold : C.border}`,
                color: C.text,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '16px',
                outline: 'none',
                borderRadius: '3px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: '12px 16px',
              background: 'rgba(231,97,97,0.08)',
              border: `1px solid rgba(231,97,97,0.3)`,
              color: C.err,
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              borderRadius: '3px',
            }}>{error}</div>
          )}

          <button
            onClick={handleReset}
            disabled={loading}
            style={{
              width: '100%',
              padding: '17px',
              background: loading ? '#3A3A3A' : C.gold,
              color: loading ? C.textMute : '#1A1A1A',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              fontWeight: 700,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              borderRadius: '3px',
              minHeight: '54px',
            }}
          >{loading ? 'Sending...' : 'Send Reset Link →'}</button>
        </div>

        <div style={{
          textAlign: 'center',
          marginTop: '28px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px',
        }}>
          <Link href="/login" style={{ color: C.gold, textDecoration: 'none', fontWeight: 500 }}>Back to sign in</Link>
        </div>
      </div>
    </div>
  )
}
