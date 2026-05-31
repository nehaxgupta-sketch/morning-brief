// src/pages/signup.tsx
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

type Stage = 'form' | 'verify'

function Wordmark() {
  return (
    <div style={{ textAlign: 'center', marginBottom: '36px' }}>
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

export default function Signup() {
  const [stage, setStage] = useState<Stage>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const inputStyle = (filled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '15px 16px',
    background: C.surface,
    border: `1px solid ${filled ? C.gold : C.border}`,
    color: C.text,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    outline: 'none',
    borderRadius: '3px',
    boxSizing: 'border-box' as const,
  })
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: "'DM Mono', monospace",
    fontSize: '10px',
    letterSpacing: '2px',
    color: C.textMute,
    marginBottom: '8px',
    textTransform: 'uppercase' as const,
  }

  const handleSignup = async () => {
    if (!name.trim()) { setError('Please enter your name'); return }
    if (!email.trim()) { setError('Please enter your email'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); setError('')
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: name.trim() },
        emailRedirectTo: `${window.location.origin}/onboarding`,
      }
    })
    if (error) { setError(error.message); setLoading(false); return }
    if (data.user) {
      // Write name to both auth metadata AND profiles row — survives any
      // race with the email-verification trigger.
      await supabase.auth.updateUser({ data: { full_name: name.trim() } })
      await supabase.from('profiles').upsert(
        { id: data.user.id, email: email.trim(), full_name: name.trim(), updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      )
      setStage('verify')
    }
    setLoading(false)
  }

  if (stage === 'verify') {
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
          lineHeight: '1.2',
        }}>One more step</h1>
        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          color: C.textSoft,
          lineHeight: '1.7',
          maxWidth: '320px',
          marginBottom: '32px',
        }}>
          We've sent a verification link to<br />
          <span style={{ color: C.gold }}>{email}</span><br /><br />
          Click the link in that email to verify your account and continue setting up your brief.
        </p>
        <div style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          padding: '18px 20px',
          borderRadius: '3px',
          maxWidth: '320px',
          width: '100%',
          marginBottom: '24px',
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '10px',
            letterSpacing: '1.5px',
            color: C.textMute,
            marginBottom: '8px',
          }}>CAN'T FIND IT?</div>
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            color: C.textSoft,
            lineHeight: '1.5',
          }}>
            Check your spam or junk folder. The email comes from noreply@supabase.io
          </div>
        </div>
        <button
          type="button"
          onClick={async () => { await supabase.auth.resend({ type: 'signup', email }); setError('Resent! Check your inbox.') }}
          style={{
            background: 'none',
            border: 'none',
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            letterSpacing: '1.5px',
            color: C.gold,
            cursor: 'pointer',
            textDecoration: 'underline',
            minHeight: '44px',
          }}
        >Resend verification email</button>
        {error && (
          <div style={{
            marginTop: '12px',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px',
            color: C.gold,
          }}>{error}</div>
        )}
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
          marginBottom: '36px',
        }}>Create your account</h1>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label style={labelStyle}>Your name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Priya"
              style={inputStyle(!!name)}
            />
          </div>
          <div>
            <label style={labelStyle}>Email address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="priya@email.com"
              style={inputStyle(!!email)}
            />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="8+ characters"
                onKeyDown={e => e.key === 'Enter' && handleSignup()}
                style={{ ...inputStyle(password.length >= 8), paddingRight: '46px' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  color: C.textMute,
                  fontSize: '18px',
                  lineHeight: 1,
                }}
              >{showPassword ? '🙈' : '👁'}</button>
            </div>
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
            onClick={handleSignup}
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
              marginTop: '8px',
            }}
          >{loading ? 'Creating account...' : 'Create Account →'}</button>
        </div>

        <div style={{
          textAlign: 'center',
          marginTop: '28px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px',
          color: C.textMute,
        }}>
          Already have an account?{' '}
          <Link href="/login" style={{ color: C.gold, textDecoration: 'none', fontWeight: 500 }}>Sign in</Link>
        </div>
      </div>
    </div>
  )
}
