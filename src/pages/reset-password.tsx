import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'

export default function ResetPassword() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Supabase puts the session in the URL hash after redirect
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
      else setError('Invalid or expired reset link. Please request a new one.')
    })
  }, [])

  const handleUpdate = async () => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.push('/home')
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#1A1A1A',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px'
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
            color: '#F5F1EA', letterSpacing: '-0.5px',
            lineHeight: '1', marginBottom: '4px'
          }}>Morning</div>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
            fontStyle: 'italic', color: '#C8A45A',
            letterSpacing: '-0.5px', lineHeight: '1',
            marginBottom: '20px'
          }}>Brief</div>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '22px', fontWeight: '700',
            fontStyle: 'italic', color: '#F5F1EA'
          }}>Set a new password</h1>
        </div>

        {!ready ? (
          <div style={{
            textAlign: 'center',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px', color: error ? '#ff6b6b' : '#666'
          }}>{error || 'Verifying reset link...'}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{
                display: 'block',
                fontFamily: "'DM Mono', monospace",
                fontSize: '9px', letterSpacing: '2px',
                color: '#666', marginBottom: '8px',
                textTransform: 'uppercase' as const
              }}>New password</label>
              <input
                type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="8+ characters"
                style={{
                  width: '100%', padding: '14px 16px',
                  background: '#2A2A2A',
                  border: `1px solid ${password.length >= 8 ? '#C8A45A' : '#333'}`,
                  color: '#F5F1EA',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '15px', outline: 'none', borderRadius: '2px'
                }}
              />
            </div>
            <div>
              <label style={{
                display: 'block',
                fontFamily: "'DM Mono', monospace",
                fontSize: '9px', letterSpacing: '2px',
                color: '#666', marginBottom: '8px',
                textTransform: 'uppercase' as const
              }}>Confirm password</label>
              <input
                type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat password"
                onKeyDown={e => e.key === 'Enter' && handleUpdate()}
                style={{
                  width: '100%', padding: '14px 16px',
                  background: '#2A2A2A',
                  border: `1px solid ${confirm && confirm === password ? '#C8A45A' : '#333'}`,
                  color: '#F5F1EA',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '15px', outline: 'none', borderRadius: '2px'
                }}
              />
            </div>

            {error && (
              <div style={{
                padding: '12px 16px',
                background: 'rgba(200,16,46,0.1)',
                border: '1px solid rgba(200,16,46,0.3)',
                color: '#ff6b6b',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '13px', borderRadius: '2px'
              }}>{error}</div>
            )}

            <button onClick={handleUpdate} disabled={loading} style={{
              width: '100%', padding: '16px',
              background: loading ? '#333' : '#C8A45A',
              color: loading ? '#666' : '#1A1A1A',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px', fontWeight: '600',
              letterSpacing: '1px', textTransform: 'uppercase',
              border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
              borderRadius: '2px', minHeight: '52px'
            }}>
              {loading ? 'Updating...' : 'Update Password →'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}