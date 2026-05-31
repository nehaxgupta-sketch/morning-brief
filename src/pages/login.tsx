// src/pages/login.tsx
import { useState } from 'react'
import { useRouter } from 'next/router'
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

export default function Login() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!email || !password) { setError('Please fill in both fields'); return }
    setLoading(true)
    setError('')
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError('Incorrect email or password. Please try again.')
        setLoading(false)
        return
      }
      if (data?.session) {
        window.location.href = '/home'
      } else {
        setError('Login failed. Please try again.')
        setLoading(false)
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

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
        }}>Welcome back</h1>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
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
                placeholder="••••••••"
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                style={{ ...inputStyle(!!password), paddingRight: '46px' }}
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

          <div style={{ textAlign: 'right', marginTop: '-10px' }}>
            <Link href="/forgot-password" style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '13px',
              color: C.textMute,
              textDecoration: 'none',
            }}>Forgot Password?</Link>
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
            onClick={handleLogin}
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
              marginTop: '8px',
              borderRadius: '3px',
              minHeight: '54px',
            }}
          >{loading ? 'Signing in...' : 'Sign In →'}</button>
        </div>

        <div style={{
          textAlign: 'center',
          marginTop: '28px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px',
          color: C.textMute,
        }}>
          New here?{' '}
          <Link href="/signup" style={{ color: C.gold, textDecoration: 'none', fontWeight: 500 }}>Sign up</Link>
        </div>
      </div>
    </div>
  )
}
