import { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function Login() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!email || !password) {
      setError('Please fill in both fields')
      return
    }
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Incorrect email or password. Please try again.')
      setLoading(false)
    }
    // on success, _app.tsx handles redirect
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#1A1A1A',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px'
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '9px',
            letterSpacing: '3px',
            color: '#C8A45A',
            marginBottom: '8px'
          }}>MORNING BRIEF</div>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '28px',
            fontWeight: '700',
            color: '#F5F1EA',
            fontStyle: 'italic'
          }}>Welcome back</h1>
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{
              display: 'block',
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '2px',
              color: '#888',
              marginBottom: '8px',
              textTransform: 'uppercase'
            }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              style={{
                width: '100%',
                padding: '14px 16px',
                background: '#2A2A2A',
                border: '1px solid #333',
                color: '#F5F1EA',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '15px',
                outline: 'none',
                borderRadius: '2px'
              }}
            />
          </div>

          <div>
            <label style={{
              display: 'block',
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '2px',
              color: '#888',
              marginBottom: '8px',
              textTransform: 'uppercase'
            }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{
                width: '100%',
                padding: '14px 16px',
                background: '#2A2A2A',
                border: '1px solid #333',
                color: '#F5F1EA',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '15px',
                outline: 'none',
                borderRadius: '2px'
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
              fontSize: '13px',
              borderRadius: '2px'
            }}>{error}</div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: '100%',
              padding: '16px',
              background: loading ? '#555' : '#C8A45A',
              color: '#1A1A1A',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              fontWeight: '600',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: '8px',
              borderRadius: '2px',
              minHeight: '52px'
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </div>

        <div style={{
          textAlign: 'center',
          marginTop: '24px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '13px',
          color: '#555'
        }}>
          No account yet?{' '}
          <Link href="/signup" style={{ color: '#C8A45A', textDecoration: 'none' }}>
            Create one free
          </Link>
        </div>
      </div>
    </div>
  )
}
