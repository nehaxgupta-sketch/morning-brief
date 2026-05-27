import { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function Signup() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSignup = async () => {
    if (!email || !password || !name) {
      setError('Please fill in all fields')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    setError('')

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } }
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    if (data.user) {
      // Update profile with name
      await supabase
        .from('profiles')
        .update({ full_name: name })
        .eq('id', data.user.id)

      router.push('/onboarding')
    }
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
          }}>Create your account</h1>
          <p style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '13px',
            color: '#666',
            marginTop: '8px',
            lineHeight: '1.5'
          }}>Takes 2 minutes. Your brief will be ready tomorrow at 7 AM.</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {[
            { label: 'Your name', value: name, setter: setName, type: 'text', placeholder: 'Priya' },
            { label: 'Email', value: email, setter: setEmail, type: 'email', placeholder: 'priya@email.com' },
            { label: 'Password', value: password, setter: setPassword, type: 'password', placeholder: '8+ characters' },
          ].map(({ label, value, setter, type, placeholder }) => (
            <div key={label}>
              <label style={{
                display: 'block',
                fontFamily: "'DM Mono', monospace",
                fontSize: '9px',
                letterSpacing: '2px',
                color: '#888',
                marginBottom: '8px',
                textTransform: 'uppercase'
              }}>{label}</label>
              <input
                type={type}
                value={value}
                onChange={e => setter(e.target.value)}
                placeholder={placeholder}
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
          ))}

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
            onClick={handleSignup}
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
            {loading ? 'Creating account...' : 'Create Account →'}
          </button>
        </div>

        <div style={{
          textAlign: 'center',
          marginTop: '24px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '13px',
          color: '#555'
        }}>
          Already have an account?{' '}
          <Link href="/login" style={{ color: '#C8A45A', textDecoration: 'none' }}>
            Sign in
          </Link>
        </div>
      </div>
    </div>
  )
}
