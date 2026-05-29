import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { useEffect } from 'react'

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Only run in browser, not during SSR
    if (typeof window === 'undefined') return

    window.OneSignalDeferred = window.OneSignalDeferred || []
    window.OneSignalDeferred.push(async function (OneSignal: any) {
      await OneSignal.init({
        appId: process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID!,
        // Shows the native browser permission prompt automatically
        promptOptions: {
          slidedown: {
            prompts: [
              {
                type: 'push',
                autoPrompt: true,
                text: {
                  actionMessage:
                    'Get your Morning Brief delivered the moment it's ready — every day at 7 AM.',
                  acceptButton: 'Allow',
                  cancelButton: 'Not now',
                },
                delay: {
                  pageViews: 1,   // show after 1 page view
                  timeDelay: 5,   // wait 5 seconds before showing
                },
              },
            ],
          },
        },
        // Allows notifications on localhost during development
        allowLocalhostAsSecureOrigin: true,
      })
    })
  }, [])

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        {/* OneSignal SDK — loads async, does not block page render */}
        <script
          src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js"
          defer
        />
      </Head>
      <Component {...pageProps} />
    </>
  )
}

// Extend Window type so TypeScript doesn't complain
declare global {
  interface Window {
    OneSignalDeferred: any[]
  }
}
