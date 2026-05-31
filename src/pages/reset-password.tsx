// src/pages/reset-password.tsx
import { useState, useEffect } from 'react'
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

export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
      else setError('Invalid or expired reset link. Please request a new one.')
    })
  }, [])

  const handleUpdate = async () => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    setLoading(true); setError('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) { setError(error.message); setLoading(false); return }
    window.location.href = '/home'
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
        }}>Set a new password</h1>

        {!ready ? (
          <div style={{
            textAlign: 'center',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '15px',
            color: error ? C.err : C.textMute,
          }}>{error || 'Verifying reset link...'}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <label style={labelStyle}>New password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="8+ characters"
                style={inputStyle(password.length >= 8)}
              />
            </div>
            <div>
              <label style={labelStyle}>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat password"
                onKeyDown={e => e.key === 'Enter' && handleUpdate()}
                style={inputStyle(confirm.length > 0 && confirm === password)}
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
              onClick={handleUpdate}
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
            >{loading ? 'Updating...' : 'Update Password →'}</button>
          </div>
        )}
      </div>
    </div>
  )
}
