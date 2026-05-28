import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Stage = 'form' | 'verify'

export default function Signup() {
  const [stage, setStage] = useState<Stage>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const inputStyle = (filled: boolean) => ({
    width: '100%', padding: '14px 16px', background: '#2A2A2A',
    border: `1px solid ${filled ? '#C8A45A' : '#333'}`, color: '#F5F1EA',
    fontFamily: "'DM Sans', sans-serif", fontSize: '15px', outline: 'none', borderRadius: '2px'
  })

  const labelStyle = {
    display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '9px',
    letterSpacing: '2px', color: '#999', marginBottom: '8px', textTransform: 'uppercase' as const
  }

  const handleSignup = async () => {
    if (!name.trim()) { setError('Please enter your name'); return }
    if (!email.trim()) { setError('Please enter your email'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); setError('')
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: `${window.location.origin}/onboarding` }
    })
    if (error) { setError(error.message); setLoading(false); return }
    if (data.user) {
      await supabase.from('profiles').upsert({ id: data.user.id, email: email.trim(), full_name: name.trim() })
      setStage('verify')
    }
    setLoading(false)
  }

  if (stage === 'verify') {
    return (
      <div style={{ minHeight: '100vh', background: '#1A1A1A', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '24px' }}>✉️</div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '3px', color: '#C8A45A', marginBottom: '12px' }}>CHECK YOUR EMAIL</div>
        <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: '26px', fontWeight: '700', color: '#F5F1EA', marginBottom: '16px', lineHeight: '1.2' }}>One more step</h1>
        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: '#888', lineHeight: '1.7', maxWidth: '300px', marginBottom: '32px' }}>
          We've sent a verification link to<br />
          <span style={{ color: '#C8A45A' }}>{email}</span><br /><br />
          Click the link in that email to verify your account and continue setting up your brief.
        </p>
        <div style={{ background: '#2A2A2A', border: '1px solid #333', padding: '16px 20px', borderRadius: '2px', maxWidth: '300px', width: '100%', marginBottom: '24px' }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '9px', letterSpacing: '1px', color: '#999', marginBottom: '8px' }}>CAN'T FIND IT?</div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#888', lineHeight: '1.5' }}>Check your spam or junk folder. The email comes from noreply@supabase.io</div>
        </div>
        <button onClick={async () => { await supabase.auth.resend({ type: 'signup', email }); setError('Resent! Check your inbox.') }}
          style={{ background: 'none', border: 'none', fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '1px', color: '#C8A45A', cursor: 'pointer', textDecoration: 'underline', minHeight: '44px' }}>
          Resend verification email
        </button>
        {error && <div style={{ marginTop: '12px', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#C8A45A' }}>{error}</div>}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#1A1A1A', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 'clamp(36px, 10vw, 52px)', fontWeight: '900', color: '#F5F1EA', letterSpacing: '-0.5px', lineHeight: '1', marginBottom: '4px' }}>Morning</div>
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 'clamp(36px, 10vw, 52px)', fontWeight: '900', color: '#C8A45A', letterSpacing: '-0.5px', lineHeight: '1', marginBottom: '20px' }}>Brief</div>
          <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '18px', fontWeight: '400', color: '#B0A898', marginBottom: '0' }}>Create your account</h1>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={labelStyle}>Your name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Priya" style={inputStyle(!!name)} />
          </div>
          <div>
            <label style={labelStyle}>Email address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="priya@email.com" style={inputStyle(!!email)} />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <div style={{ position: 'relative' }}>
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="8+ characters" onKeyDown={e => e.key === 'Enter' && handleSignup()}
                style={{ width: '100%', padding: '14px 44px 14px 16px', background: '#2A2A2A', border: `1px solid ${password.length >= 8 ? '#C8A45A' : '#333'}`, color: '#F5F1EA', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', outline: 'none', borderRadius: '2px', boxSizing: 'border-box' as const }} />
              <button onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '0', color: '#666', fontSize: '16px', lineHeight: '1' }}>
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          {error && <div style={{ padding: '12px 16px', background: 'rgba(200,16,46,0.1)', border: '1px solid rgba(200,16,46,0.3)', color: '#ff6b6b', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', borderRadius: '2px' }}>{error}</div>}

          <button onClick={handleSignup} disabled={loading} style={{ width: '100%', padding: '16px', background: loading ? '#333' : '#C8A45A', color: loading ? '#666' : '#1A1A1A', fontFamily: "'DM Sans', sans-serif", fontSize: '14px', fontWeight: '600', letterSpacing: '1px', textTransform: 'uppercase', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', borderRadius: '2px', minHeight: '52px', marginTop: '8px' }}>
            {loading ? 'Creating account...' : 'Create Account →'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: '24px', fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#888' }}>
          Already have an account?{' '}
          <Link href="/login" style={{ color: '#C8A45A', textDecoration: 'none' }}>Sign in</Link>
        </div>
      </div>
    </div>
  )
}