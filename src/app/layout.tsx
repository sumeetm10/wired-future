import type { Metadata, Viewport } from 'next';
import { Chakra_Petch, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// next/font self-hosts the woff2 at build time, so the static export carries
// the fonts itself - no runtime request to Google, and no FOUT on GitHub Pages.
const chakraPetch = Chakra_Petch({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-chakra-petch',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  // Static export has no request context, so absolute OG URLs need a base.
  // Change the host if you publish anywhere other than GitHub Pages.
  metadataBase: new URL('https://wired-future.github.io/wired-future/'),
  title: 'Wired Future — Agent-Native Design Canvas',
  description:
    'A collaborative 3D creative canvas where a human and an AI agent work on the exact same screen. Built on WebMCP (navigator.modelContext) for the OpenAI WebMCP Challenge.',
  applicationName: 'Wired Future',
  authors: [{ name: 'Wired Future' }],
  keywords: ['WebMCP', 'modelContext', 'agent-native', 'three.js', 'creative canvas'],
  openGraph: {
    title: 'Wired Future — Agent-Native Design Canvas',
    description:
      'One action, two interfaces. Every control a human can touch, an AI agent can call.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b071e',
  width: 'device-width',
  initialScale: 1,
  // No maximumScale: the layout is entirely position:fixed with overflow
  // hidden, so there is no zoom-on-focus jump to suppress, and blocking
  // pinch-zoom on 11px monospace trace text is an accessibility failure.
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={chakraPetch.variable + ' ' + jetbrainsMono.variable}
    >
      <body>
        <noscript>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 100,
              display: 'grid',
              placeItems: 'center',
              background: '#0b071e',
              color: '#cfe9ff',
              padding: '24px',
              textAlign: 'center',
              font: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            <p>
              Wired Future renders a live WebGL scene and registers WebMCP tools
              on navigator.modelContext. Both need JavaScript. Enable it and
              reload.
            </p>
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
