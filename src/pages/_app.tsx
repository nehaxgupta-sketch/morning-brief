import type { AppProps } from 'next/app'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'
import '@/styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const publicRoutes = ['/login', '/signup', '/', '/verify']

    // TIMEOUT — never hang forever
    const timeout = setTimeout(() => {
      setLoading(false)
      if (!publicRoutes.includes(router.pathname)) {
        router.push('/login')
      }
    }, 4000)

    supabase.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(timeout)
      const isPublic = publicRoutes.includes(router.pathname)
      if (!session && !isPublic) {
        router.push('/login')
      }
      setLoading(false)
    }).catch(() => {
      clearTimeout(timeout)
      setLoading(false)
      router.push('/login')
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('onboarding_complete')
            .eq('id', session.user.id)
            .single()

          if (!profile?.onboarding_complete) {
            router.push('/onboarding')
          } else if (publicRoutes.includes(router.pathname)) {
            router.push('/home')
          }
        }
        if (event === 'SIGNED_OUT') {
          router.push('/login')
        }
      }
    )

    return () => {
      clearTimeout(timeout)
      subscription.unsubscribe()
    }
  }, [])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#F5F1EA',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px'
      }}>
        <div style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: '28px',
          fontWeight: '900',
          fontStyle: 'italic',
          color: '#C8A45A',
          letterSpacing: '-0.5px'
        }}>Morning Brief</div>
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'center'
        }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: '6px', height: '6px',
              borderRadius: '50%',
              background: '#C8A45A',
              opacity: 0.4,
              animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`
            }} />
          ))}
        </div>
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 0.2; transform: scale(0.8); }
            50% { opacity: 1; transform: scale(1.2); }
          }
        `}</style>
      </div>
    )
  }

  return <Component {...pageProps} />
}
