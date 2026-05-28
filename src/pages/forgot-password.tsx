import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Stage = 'form' | 'sent'

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
      redirectTo: `${window.location.origin}/reset-password`
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setStage('sent')
    setLoading(false)
  }

  if (stage === 'sent') {
    return (
      <div style={{
        minHeight: '100vh', background: '#1A1A1A',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', textAlign: 'center'
      }}>
        <div style={{ fontSize: '48px', marginBottom: '24px' }}>✉️</div>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: '9px',
          letterSpacing: '3px', color: '#C8A45A', marginBottom: '12px'
        }}>CHECK YOUR EMAIL</div>
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '26px', fontWeight: '700',
          fontStyle: 'italic', color: '#F5F1EA',
          marginBottom: '16px'
        }}>Reset link sent</h1>
        <p style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px', color: '#666',
          lineHeight: '1.7', maxWidth: '300px', marginBottom: '32px'
        }}>
          We've sent a password reset link to<br />
          <span style={{ color: '#C8A45A' }}>{email}</span><br /><br />
          Click the link in that email to set a new password.
        </p>
        <Link href="/login" style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: '10px', letterSpacing: '1px',
          color: '#C8A45A', textDecoration: 'underline'
        }}>Back to sign in</Link>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#1A1A1A',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px'
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Header */}
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
            fontStyle: 'italic', color: '#F5F1EA',
            marginBottom: '8px'
          }}>Reset your password</h1>
          <p style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px', color: '#666', lineHeight: '1.5'
          }}>Enter your email and we'll send you a reset link.</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{
              display: 'block',
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px', letterSpacing: '2px',
              color: '#666', marginBottom: '8px',
              textTransform: 'uppercase' as const
            }}>Email address</label>
            <input
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="priya@email.com"
              onKeyDown={e => e.key === 'Enter' && handleReset()}
              style={{
                width: '100%', padding: '14px 16px',
                background: '#2A2A2A',
                border: `1px solid ${email ? '#C8A45A' : '#333'}`,
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

          <button onClick={handleReset} disabled={loading} style={{
            width: '100%', padding: '16px',
            background: loading ? '#333' : '#C8A45A',
            color: loading ? '#666' : '#1A1A1A',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '14px', fontWeight: '600',
            letterSpacing: '1px', textTransform: 'uppercase',
            border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
            borderRadius: '2px', minHeight: '52px'
          }}>
            {loading ? 'Sending...' : 'Send Reset Link →'}
          </button>
        </div>

        <div style={{
          textAlign: 'center', marginTop: '24px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '13px', color: '#444'
        }}>
          <Link href="/login" style={{ color: '#C8A45A', textDecoration: 'none' }}>Back to sign in</Link>
        </div>
      </div>
    </div>
  )
}