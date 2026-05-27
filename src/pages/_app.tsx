import type { AppProps } from 'next/app'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '@/lib/supabase'
import '@/styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check auth state on load
    supabase.auth.getSession().then(({ data: { session } }) => {
      const publicRoutes = ['/login', '/signup', '/']
      const isPublic = publicRoutes.includes(router.pathname)

      if (!session && !isPublic) {
        router.push('/login')
      }
      setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          // Check if onboarding is complete
          const { data: profile } = await supabase
            .from('profiles')
            .select('onboarding_complete')
            .eq('id', session.user.id)
            .single()

          if (profile && !profile.onboarding_complete) {
            router.push('/onboarding')
          } else if (router.pathname === '/login' || router.pathname === '/signup') {
            router.push('/home')
          }
        }
        if (event === 'SIGNED_OUT') {
          router.push('/login')
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#F5F1EA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: 'Georgia, serif',
            fontSize: '11px',
            letterSpacing: '3px',
            color: '#C8A45A',
            textTransform: 'uppercase'
          }}>
            Morning Brief
          </div>
        </div>
      </div>
    )
  }

  return <Component {...pageProps} />
}
