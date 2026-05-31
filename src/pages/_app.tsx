// src/pages/_app.tsx
import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { useEffect } from 'react'

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    if (typeof window === 'undefined') return

    window.OneSignalDeferred = window.OneSignalDeferred || []
    window.OneSignalDeferred.push(async function (OneSignal: any) {
      await OneSignal.init({
        appId: process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID!,
        promptOptions: {
          slidedown: {
            prompts: [
              {
                type: 'push',
                autoPrompt: true,
                text: {
                  actionMessage:
                    "Get your Morning Brief the moment it is ready — every day at 7 AM.",
                  acceptButton: 'Allow',
                  cancelButton: 'Not now',
                },
                delay: { pageViews: 1, timeDelay: 5 },
              },
            ],
          },
        },
        allowLocalhostAsSecureOrigin: true,
      })
    })
  }, [])

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0E0E0E" />
        <link rel="manifest" href="/manifest.json" />
        <script
          src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js"
          defer
        />
      </Head>
      <Component {...pageProps} />
    </>
  )
}

declare global {
  interface Window {
    OneSignalDeferred: any[]
  }
}
