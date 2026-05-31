// src/pages/_document.tsx
import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0E0E0E" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Morning Brief" />

        {/* Google Fonts — preconnect + actual stylesheet link.
            The previous version only preconnected, so the fonts never loaded
            consistently. This loads them properly with display=swap. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800;900&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap"
        />

        {/* Meta */}
        <meta name="description" content="Your personalised morning newspaper" />
        <meta property="og:title" content="Morning Brief" />
        <meta property="og:description" content="Your personalised morning newspaper" />
      </Head>
      <body style={{ background: '#0E0E0E' }}>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
