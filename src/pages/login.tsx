import { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

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
    } catch (e) {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#1A1A1A', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 'clamp(36px, 10vw, 52px)', fontWeight: '900', color: '#F5F1EA', letterSpacing: '-0.5px', lineHeight: '1', marginBottom: '4px' }}>Morning</div>
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 'clamp(36px, 10vw, 52px)', fontWeight: '900', color: '#C8A45A', letterSpacing: '-0.5px', lineHeight: '1', marginBottom: '20px' }}>Brief</div>
          <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '18px', fontWeight: '400', color: '#B0A898' }}>Welcome back</h1>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#999', marginBottom: '8px', textTransform: 'uppercase' as const }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com"
              style={{ width: '100%', padding: '14px 16px', background: '#2A2A2A', border: `1px solid ${email ? '#C8A45A' : '#333'}`, color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', outline: 'none', borderRadius: '2px' }} />
          </div>

          <div>
            <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '2px', color: '#999', marginBottom: '8px', textTransform: 'uppercase' as const }}>Password</label>
            <div style={{ position: 'relative' }}>
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && handleLogin()}
                style={{ width: '100%', padding: '14px 44px 14px 16px', background: '#2A2A2A', border: `1px solid ${password ? '#C8A45A' : '#333'}`, color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', outline: 'none', borderRadius: '2px', boxSizing: 'border-box' as const }} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '0', color: '#666', fontSize: '16px', lineHeight: '1' }}>
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div style={{ textAlign: 'right', marginTop: '-12px' }}>
            <Link href="/forgot-password" style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '12px', color: '#666', textDecoration: 'none' }}>Forgot Password?</Link>
          </div>

          {error && <div style={{ padding: '12px 16px', background: 'rgba(200,16,46,0.1)', border: '1px solid rgba(200,16,46,0.3)', color: '#ff6b6b', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', borderRadius: '2px' }}>{error}</div>}

          <button onClick={handleLogin} disabled={loading} style={{ width: '100%', padding: '16px', background: loading ? '#555' : '#C8A45A', color: '#1A1A1A', fontFamily: "'DM Sans', sans-serif", fontSize: '14px', fontWeight: '600', letterSpacing: '1px', textTransform: 'uppercase', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', marginTop: '8px', borderRadius: '2px', minHeight: '52px' }}>
            {loading ? 'Signing in...' : 'Sign In →'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: '24px', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#888' }}>
          New here?{' '}
          <Link href="/signup" style={{ color: '#C8A45A', textDecoration: 'none' }}>Sign up</Link>
        </div>
      </div>
    </div>
  )
}